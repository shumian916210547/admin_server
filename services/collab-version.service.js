"use strict";

const crypto = require("crypto");

const { badRequest } = require("../lib/http-error");
const { queryCollab, withCollabTransaction } = require("./collab-database.service");
const {
  collabError,
  documentDtoForAuth,
  getDocumentAccess,
  getTenantDocument,
  normalizeDocumentId,
} = require("./collab-access.service");
const { assertDocumentFileSizeWithinLimit, readObject } = require("./collab-storage.service");
const { recordCollabAudit } = require("./collab-audit.service");

/**
 * 校验命名版本标题，禁止控制字符并限制长度，避免审计和列表出现不可读内容。
 * @param {unknown} value 请求体中的版本名称。
 * @returns {string} 规范化后的版本名称。
 * @throws {import("../lib/http-error").HttpError} 标题为空、超长或含控制字符时抛出 400。
 */
function normalizeVersionLabel(value) {
  if (typeof value !== "string") throw badRequest("版本名称不能为空");
  const label = value.trim();
  if (!label || label.length > 100 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw badRequest("版本名称不能为空且不能超过 100 个字符");
  }
  return label;
}

/**
 * 将 PostgreSQL 版本行转换为前端版本历史 DTO，不返回物理文件路径。
 * @param {Record<string, unknown>} version 版本数据库行。
 * @returns {Record<string, unknown>} 版本安全 DTO。
 */
function versionDto(version) {
  return {
    id: version.id,
    documentId: version.document_id,
    versionNo: Number(version.version_no),
    revision: Number(version.revision),
    label: version.label,
    sha256: version.sha256,
    sizeBytes: Number(version.size_bytes),
    createdBy: version.created_by,
    createdAt: new Date(version.created_at).toISOString(),
    restoredFromVersionId: version.restored_from_version_id || null,
  };
}

/**
 * 查询当前用户可见文档的命名版本和初始版本记录。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @returns {Promise<{documentId: string, currentVersionId: string | null, currentRevision: number, versions: Array<Record<string, unknown>>}>} 版本列表。
 * @throws {import("../lib/http-error").HttpError} 页面权限、文档 ACL 或数据库查询失败时抛出。
 */
async function listDocumentVersions(auth, documentId) {
  const normalizedId = normalizeDocumentId(documentId);
  const document = await getTenantDocument(auth.companyId, normalizedId);
  await getDocumentAccess(auth, document, { pageAction: "history" });
  const result = await queryCollab(
    `SELECT id, document_id, version_no, revision, object_key, sha256, size_bytes, label,
            created_by, created_at, restored_from_version_id
       FROM collab.document_versions
      WHERE document_id = $1::uuid
      ORDER BY version_no DESC`,
    [normalizedId]
  );
  return {
    documentId: normalizedId,
    currentVersionId: document.current_version_id || null,
    currentRevision: Number(document.current_revision),
    versions: result.rows.map(versionDto),
  };
}

/**
 * 为当前文档源文件创建一个命名版本，版本对象使用现有不可变对象键。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {{label?: unknown}} input 命名版本请求体。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID。
 * @returns {Promise<Record<string, unknown>>} 新建版本 DTO。
 * @throws {import("../lib/http-error").HttpError} 无编辑权限、文件缺失或输入非法时抛出。
 */
async function createDocumentVersion(auth, documentId, input = {}, requestId) {
  const normalizedId = normalizeDocumentId(documentId);
  const document = await getTenantDocument(auth.companyId, normalizedId);
  await getDocumentAccess(auth, document, { pageAction: "history", require: "edit" });
  const label = normalizeVersionLabel(input.label);
  if (!document.source_object_key) throw collabError(404, "COLLAB_FILE_NOT_FOUND", "文档当前没有可保存的文件");
  const buffer = await readObject(document.source_object_key);
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  const version = await withCollabTransaction(async (client) => {
    const locked = await client.query(
      `SELECT current_revision, current_version_id, source_object_key, storage_limit_bytes
         FROM collab.documents WHERE id = $1::uuid AND company_id = $2 AND status = 'active' FOR UPDATE`,
      [normalizedId, auth.companyId]
    );
    if (!locked.rowCount) throw collabError(409, "COLLAB_DOCUMENT_ARCHIVED", "文档当前不可创建版本");
    const next = await client.query(
      "SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM collab.document_versions WHERE document_id = $1::uuid",
      [normalizedId]
    );
    const versionId = crypto.randomUUID();
    const versionNo = Number(next.rows[0].version_no);
    const revision = Number(locked.rows[0].current_revision);
    assertDocumentFileSizeWithinLimit(locked.rows[0], buffer.length);
    await client.query(
      `INSERT INTO collab.document_versions
        (id, document_id, version_no, revision, object_key, sha256, size_bytes, label, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
      [versionId, normalizedId, versionNo, revision, locked.rows[0].source_object_key, digest, buffer.length, label, auth.userId]
    );
    await client.query(
      "UPDATE collab.documents SET current_version_id = $2::uuid, updated_by = $3, updated_at = now() WHERE id = $1::uuid",
      [normalizedId, versionId, auth.userId]
    );
    await recordCollabAudit(
      {
        documentId: normalizedId,
        companyId: auth.companyId,
        actorUserId: auth.userId,
        action: "version.created",
        requestId,
        revision,
        metadata: { label, versionNo },
      },
      client
    );
    return { id: versionId, document_id: normalizedId, version_no: versionNo, revision, object_key: locked.rows[0].source_object_key, sha256: digest, size_bytes: buffer.length, label, created_by: auth.userId, created_at: new Date().toISOString(), restored_from_version_id: null };
  });
  return versionDto(version);
}

/**
 * 从历史版本创建新的恢复版本并递增当前 revision，不覆盖原历史记录。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {unknown} versionId 历史版本 UUID。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID。
 * @returns {Promise<{document: Record<string, unknown>, version: Record<string, unknown>}>} 恢复后的文档和新版本 DTO。
 * @throws {import("../lib/http-error").HttpError} 无编辑权限、版本不存在或文档状态冲突时抛出。
 */
async function restoreDocumentVersion(auth, documentId, versionId, requestId) {
  const normalizedId = normalizeDocumentId(documentId);
  if (typeof versionId !== "string" || !/^[a-f0-9-]{36}$/i.test(versionId)) throw badRequest("版本标识格式无效");
  const document = await getTenantDocument(auth.companyId, normalizedId);
  await getDocumentAccess(auth, document, { pageAction: "history", require: "edit" });
  const restored = await withCollabTransaction(async (client) => {
    const lockedDocument = await client.query(
      `SELECT id, current_revision, storage_limit_bytes FROM collab.documents
        WHERE id = $1::uuid AND company_id = $2 AND status = 'active' FOR UPDATE`,
      [normalizedId, auth.companyId]
    );
    if (!lockedDocument.rowCount) throw collabError(409, "COLLAB_DOCUMENT_ARCHIVED", "文档当前不可恢复版本");
    const source = await client.query(
      `SELECT id, object_key, sha256, size_bytes, label FROM collab.document_versions
        WHERE id = $1::uuid AND document_id = $2::uuid`,
      [versionId, normalizedId]
    );
    if (!source.rowCount) throw collabError(404, "COLLAB_VERSION_NOT_FOUND", "历史版本不存在");
    const sourceVersion = source.rows[0];
    assertDocumentFileSizeWithinLimit(lockedDocument.rows[0], sourceVersion.size_bytes);
    const next = await client.query(
      "SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM collab.document_versions WHERE document_id = $1::uuid",
      [normalizedId]
    );
    const versionNo = Number(next.rows[0].version_no);
    const revision = Number(lockedDocument.rows[0].current_revision) + 1;
    const newVersionId = crypto.randomUUID();
    const label = `恢复：${sourceVersion.label}`.slice(0, 100);
    await client.query(
      `INSERT INTO collab.document_versions
        (id, document_id, version_no, revision, object_key, sha256, size_bytes, label, created_by, restored_from_version_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid)`,
      [newVersionId, normalizedId, versionNo, revision, sourceVersion.object_key, sourceVersion.sha256, sourceVersion.size_bytes, label, auth.userId, sourceVersion.id]
    );
    const updated = await client.query(
      `UPDATE collab.documents SET source_object_key = $3, current_version_id = $4::uuid,
        current_revision = $5, updated_by = $6, updated_at = now()
        WHERE id = $1::uuid AND company_id = $2
        RETURNING id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
                  access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
                  created_by, updated_by, created_at, updated_at, deleted_at`,
      [normalizedId, auth.companyId, sourceVersion.object_key, newVersionId, revision, auth.userId]
    );
    await recordCollabAudit(
      {
        documentId: normalizedId,
        companyId: auth.companyId,
        actorUserId: auth.userId,
        action: "version.restored",
        requestId,
        revision,
        metadata: { restoredFromVersionId: sourceVersion.id, versionNo },
      },
      client
    );
    return {
      document: updated.rows[0],
      version: { id: newVersionId, document_id: normalizedId, version_no: versionNo, revision, object_key: sourceVersion.object_key, sha256: sourceVersion.sha256, size_bytes: sourceVersion.size_bytes, label, created_by: auth.userId, created_at: new Date().toISOString(), restored_from_version_id: sourceVersion.id },
    };
  });
  const access = await getDocumentAccess(auth, restored.document, { pageAction: "query" });
  return { document: await documentDtoForAuth(auth, restored.document, access), version: versionDto(restored.version) };
}

module.exports = {
  listDocumentVersions,
  createDocumentVersion,
  restoreDocumentVersion,
};
