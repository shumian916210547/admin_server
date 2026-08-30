"use strict";

const crypto = require("crypto");
const Parse = require("parse/node");

const { config } = require("../config/env");
const { badRequest } = require("../lib/http-error");
const {
  assertCollabDatabaseReady,
  queryCollab,
  withCollabTransaction,
} = require("./collab-database.service");
const {
  assertCollabPagePermission,
  collabError,
  documentDtoForAuth,
  getDocumentAccess,
  getTenantDocument,
  isUserInOrganizationScope,
  listDocuments,
  normalizeAccessMode,
  normalizeBoolean,
  normalizeDocumentName,
  normalizeObjectId,
} = require("./collab-access.service");
const { master, pointer } = require("./parse-data.service");
const {
  assertDocumentFileSizeWithinLimit,
  createBlankWorkbook,
  getExistingObjectPath,
  mimeTypeForObjectKey,
  normalizeStorageLimit,
  removeObject,
  storeUploadedFile,
} = require("./collab-storage.service");
const { recordCollabAudit } = require("./collab-audit.service");

/**
 * 校验一个当前 Company 内启用的组织，避免文档范围引用跨租户或已停用节点。
 * @param {string} companyId 当前认证上下文中的 Company objectId。
 * @param {string | null} organizationId 文档组织范围 objectId，可为空。
 * @returns {Promise<void>} 组织为空或属于当前 Company 且启用时兑现。
 * @throws {import("../lib/http-error").HttpError} 组织不存在、停用或跨租户时抛出 400。
 */
async function assertActiveOrganization(companyId, organizationId) {
  if (!organizationId) return;
  const query = new Parse.Query("Organization");
  query.equalTo("company", pointer("Company", companyId));
  query.equalTo("objectId", organizationId);
  query.equalTo("isActive", true);
  if (!(await query.first(master))) throw collabError(400, "COLLAB_ORGANIZATION_INVALID", "组织不存在或已停用");
}

/**
 * 校验文档管理操作的资源级 owner 边界；系统管理员可执行平台级恢复或删除。
 * @param {{userId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {{owner_user_id: string}} document 已通过当前 Company 查询的文档行。
 * @returns {void} 当前用户是 owner 或系统管理员时正常返回。
 * @throws {import("../lib/http-error").HttpError} 普通成员不是 owner 时抛出 403。
 */
function assertDocumentManager(auth, document) {
  if (!auth?.isAdmin && document.owner_user_id !== auth?.userId) {
    throw collabError(403, "COLLAB_SHARE_DENIED", "只有文档创建者或系统管理员可以管理文档状态");
  }
}

/**
 * 创建文档初始数据库记录、owner ACL 和空白 xlsx 初始版本；Company 与 owner 只来自认证上下文。
 * @param {{companyId: string, userId: string, user?: import("parse/node").User, isAdmin?: boolean, roleId?: string, role?: import("parse/node").Object}} auth 可信认证上下文。
 * @param {{name?: unknown, accessMode?: unknown, organizationId?: unknown, allowDownload?: unknown, storageLimit?: unknown, storageLimitBytes?: unknown}} [input] 创建请求体，只接受文档业务字段。
 * @param {string | undefined} [requestId] 当前 HTTP 请求 ID。
 * @returns {Promise<Record<string, unknown>>} 创建后的文档安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 页面权限、组织范围、输入或数据库写入失败时抛出。
 */
async function createDocument(auth, input = {}, requestId) {
  await assertCollabPagePermission(auth, "insert");
  // 创建完成后会立即返回可读取的文档 DTO，因此先确认 query 权限，避免仅有 insert 权限的请求留下孤立记录。
  await assertCollabPagePermission(auth, "query");
  const name = normalizeDocumentName(input.name === undefined ? "未命名工作簿" : input.name);
  const accessMode = normalizeAccessMode(input.accessMode);
  const organizationId = normalizeObjectId(input.organizationId, "组织标识", false);
  const allowDownload = normalizeBoolean(input.allowDownload, false);
  const storageLimitInput = input.storageLimit !== undefined ? input.storageLimit : input.storageLimitBytes;
  const storageLimitBytes = normalizeStorageLimit(storageLimitInput) ?? null;
  await assertActiveOrganization(auth.companyId, organizationId);
  if (!auth.isAdmin && organizationId && !(await isUserInOrganizationScope(auth.user, organizationId, auth.companyId))) {
    throw collabError(403, "COLLAB_ORGANIZATION_OUT_OF_SCOPE", "不能把文档范围设置到当前操作者无权管理的组织");
  }

  const id = crypto.randomUUID();
  const source = await createBlankWorkbook(id);
  const engine = config.collab.office.browserUrl ? "onlyoffice" : "custom";
  let persisted = false;
  try {
    assertDocumentFileSizeWithinLimit(storageLimitBytes, source.sizeBytes);
    const document = await withCollabTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO collab.documents
          (id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
           access_version, current_revision, source_object_key, allow_download, storage_limit_bytes, created_by, updated_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'active', 1, 0, $8, $9, $10, $4, $4)
         RETURNING id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
                   access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
                   created_by, updated_by, created_at, updated_at, deleted_at`,
        [id, auth.companyId, organizationId, auth.userId, name, engine, accessMode, source.objectKey, allowDownload, storageLimitBytes]
      );
      const versionId = crypto.randomUUID();
      await client.query(
        `INSERT INTO collab.document_versions
          (id, document_id, version_no, revision, object_key, sha256, size_bytes, label, created_by)
         VALUES ($1::uuid, $2::uuid, 1, 0, $3, $4, $5, '初始版本', $6)`,
        [versionId, id, source.objectKey, source.sha256, source.sizeBytes, auth.userId]
      );
      const updated = await client.query(
        `UPDATE collab.documents SET current_version_id = $2::uuid, updated_at = now()
          WHERE id = $1::uuid RETURNING id, company_id, organization_id, owner_user_id, name, engine,
          access_mode, status, access_version, current_revision, current_version_id, source_object_key,
          allow_download, storage_limit_bytes, created_by, updated_by, created_at, updated_at, deleted_at`,
        [id, versionId]
      );
      await client.query(
        `INSERT INTO collab.document_members
          (document_id, user_id, role, status, can_download, granted_by)
         VALUES ($1::uuid, $2, 'owner', 'active', $3, $2)`,
        [id, auth.userId, allowDownload]
      );
      await recordCollabAudit(
        {
          documentId: id,
          companyId: auth.companyId,
          actorUserId: auth.userId,
          action: "document.created",
          requestId,
          revision: 0,
          metadata: { accessMode, organizationId, engine, allowDownload, storageLimitBytes },
        },
        client
      );
      return updated.rows[0] || created.rows[0];
    });
    // 事务提交后文件已被文档记录引用；后续 DTO 读取失败时不能删除该对象。
    persisted = true;
    const access = await getDocumentAccess(auth, document, { pageAction: "query" });
    return documentDtoForAuth(auth, document, access);
  } catch (error) {
    if (!persisted) await removeObject(source.objectKey).catch(() => undefined);
    throw error;
  }
}

/**
 * 查询当前用户可见的协同文档列表。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {Record<string, unknown>} query URL 查询参数。
 * @returns {Promise<{documents: Array<Record<string, unknown>>, count: number, page: number, pageSize: number}>} 文档列表 DTO。
 * @throws {Error} 页面权限、组织范围或数据库查询失败时抛出。
 */
async function queryDocuments(auth, query) {
  return listDocuments(auth, query);
}

/**
 * 修改文档名称、归档状态、下载总开关或文档容量上限；状态 deleted 只能通过软删除接口设置。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {{name?: unknown, status?: unknown, allowDownload?: unknown, storageLimit?: unknown, storageLimitBytes?: unknown}} input 可修改的业务字段。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID。
 * @returns {Promise<Record<string, unknown>>} 更新后的文档安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 文档 ACL、状态或输入不合法时抛出。
 */
async function updateDocument(auth, documentId, input = {}, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  const hasNameChange = input.name !== undefined;
  const hasStatusChange = input.status !== undefined;
  const hasDownloadChange = input.allowDownload !== undefined;
  const hasStorageLimitChange = input.storageLimit !== undefined || input.storageLimitBytes !== undefined;
  if (!hasNameChange && !hasStatusChange && !hasDownloadChange && !hasStorageLimitChange) throw badRequest("没有可修改的文档字段");
  const primaryPageAction = hasNameChange ? "edit" : hasStatusChange ? "remove" : "share";
  const access = await getDocumentAccess(auth, document, {
    pageAction: primaryPageAction,
    require: hasNameChange ? "edit" : hasDownloadChange || hasStorageLimitChange ? "share" : undefined,
  });
  if (hasStatusChange) {
    if (primaryPageAction !== "remove") await assertCollabPagePermission(auth, "remove");
    assertDocumentManager(auth, document);
  }
  const sets = [];
  const params = [document.id, auth.companyId];
  const metadata = {};
  let accessVersionChanged = false;
  let storageLimitBytes;
  if (input.name !== undefined) {
    sets.push(`name = $${params.length + 1}`);
    params.push(normalizeDocumentName(input.name));
    metadata.nameChanged = true;
  }
  if (input.status !== undefined) {
    if (!["active", "archived"].includes(input.status)) throw badRequest("文档状态只能是 active 或 archived");
    sets.push(`status = $${params.length + 1}`);
    params.push(input.status);
    if (input.status !== document.status) accessVersionChanged = true;
    metadata.status = input.status;
  }
  if (input.allowDownload !== undefined) {
    if (!access.canShare) throw collabError(403, "COLLAB_SHARE_DENIED", "只有文档创建者可以修改下载策略");
    const allowDownload = normalizeBoolean(input.allowDownload, false);
    sets.push(`allow_download = $${params.length + 1}`);
    params.push(allowDownload);
    if (allowDownload !== document.allow_download) accessVersionChanged = true;
    metadata.allowDownload = params[params.length - 1];
  }
  if (hasStorageLimitChange) {
    if (!access.canShare) throw collabError(403, "COLLAB_SHARE_DENIED", "只有文档创建者可以修改容量上限");
    const storageLimitInput = input.storageLimit !== undefined ? input.storageLimit : input.storageLimitBytes;
    storageLimitBytes = normalizeStorageLimit(storageLimitInput);
    assertDocumentFileSizeWithinLimit(storageLimitBytes, document.file_size_bytes || 0);
    sets.push(`storage_limit_bytes = $${params.length + 1}`);
    params.push(storageLimitBytes);
    metadata.storageLimitBytes = storageLimitBytes;
  }
  if (!sets.length) throw badRequest("没有可修改的文档字段");
  if (accessVersionChanged) sets.push("access_version = access_version + 1");
  params.push(auth.userId);
  sets.push(`updated_by = $${params.length}`, "updated_at = now()");
  const updatedDocument = await withCollabTransaction(async (client) => {
    if (hasStorageLimitChange) {
      const current = await client.query(
        `SELECT storage_limit_bytes,
                COALESCE((SELECT size_bytes FROM collab.document_versions AS current_version
                          WHERE current_version.id = documents.current_version_id), 0) AS file_size_bytes
           FROM collab.documents AS documents
          WHERE id = $1::uuid AND company_id = $2 AND status <> 'deleted'
          FOR UPDATE`,
        [document.id, auth.companyId]
      );
      if (!current.rowCount) throw collabError(404, "COLLAB_DOCUMENT_NOT_FOUND", "文档不存在或已删除");
      assertDocumentFileSizeWithinLimit(storageLimitBytes, current.rows[0].file_size_bytes);
    }
    const updated = await client.query(
      `UPDATE collab.documents SET ${sets.join(", ")}
        WHERE id = $1::uuid AND company_id = $2 AND status <> 'deleted'
        RETURNING id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
                  access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
                  created_by, updated_by, created_at, updated_at, deleted_at`,
      params
    );
    if (!updated.rowCount) throw collabError(404, "COLLAB_DOCUMENT_NOT_FOUND", "文档不存在或已删除");
    const result = updated.rows[0];
    await recordCollabAudit(
      {
        documentId: result.id,
        companyId: auth.companyId,
        actorUserId: auth.userId,
        action: "document.updated",
        requestId,
        metadata,
      },
      client
    );
    return result;
  });
  const updatedAccess = await getDocumentAccess(auth, updatedDocument, { pageAction: "query" });
  return documentDtoForAuth(auth, updatedDocument, updatedAccess);
}

/**
 * 将文档标记为 deleted 并递增 ACL 版本，文件对象保留给延迟清理和恢复窗口使用。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID。
 * @returns {Promise<void>} 软删除和审计写入完成后兑现。
 * @throws {import("../lib/http-error").HttpError} 非 owner/管理员、文档不存在或状态不允许时抛出。
 */
async function softDeleteDocument(auth, documentId, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  await getDocumentAccess(auth, document, { pageAction: "remove" });
  assertDocumentManager(auth, document);
  await withCollabTransaction(async (client) => {
    const result = await client.query(
      `UPDATE collab.documents
          SET status = 'deleted', deleted_at = now(), access_version = access_version + 1,
              updated_by = $3, updated_at = now()
        WHERE id = $1::uuid AND company_id = $2 AND status <> 'deleted'`,
      [document.id, auth.companyId, auth.userId]
    );
    if (!result.rowCount) throw collabError(404, "COLLAB_DOCUMENT_NOT_FOUND", "文档不存在或已删除");
    await recordCollabAudit(
      { documentId: document.id, companyId: auth.companyId, actorUserId: auth.userId, action: "document.deleted", requestId },
      client
    );
  });
}

/**
 * 恢复软删除文档，使用新访问版本并保留历史版本记录。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID。
 * @returns {Promise<Record<string, unknown>>} 恢复后的文档安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 无恢复权限、文档不存在或状态冲突时抛出。
 */
async function restoreDocument(auth, documentId, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId, { includeDeleted: true });
  await getDocumentAccess(auth, document, { pageAction: "remove", allowDeleted: true });
  assertDocumentManager(auth, document);
  const result = await withCollabTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE collab.documents
          SET status = 'active', deleted_at = NULL, access_version = access_version + 1,
              updated_by = $3, updated_at = now()
        WHERE id = $1::uuid AND company_id = $2 AND status = 'deleted'
        RETURNING id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
                  access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
                  created_by, updated_by, created_at, updated_at, deleted_at`,
      [document.id, auth.companyId, auth.userId]
    );
    if (!updated.rowCount) throw collabError(409, "COLLAB_DOCUMENT_STATUS_CONFLICT", "文档当前状态已发生变化");
    await recordCollabAudit(
      { documentId: document.id, companyId: auth.companyId, actorUserId: auth.userId, action: "document.restored", requestId },
      client
    );
    return updated.rows[0];
  });
  const updatedAccess = await getDocumentAccess(auth, result, { pageAction: "query" });
  return documentDtoForAuth(auth, result, updatedAccess);
}

/**
 * 将 xlsx/csv 导入文档，文件先经过格式和压缩包安全检查，再以新版本写入数据库。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {{path?: string, originalname?: string, mimetype?: string}} file multer 临时上传文件。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID。
 * @returns {Promise<Record<string, unknown>>} 导入后的文档安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 文件缺失、格式不安全、无编辑权限或数据库写入失败时抛出。
 */
async function importDocument(auth, documentId, file, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  await getDocumentAccess(auth, document, { pageAction: "import", require: "edit" });
  if (!file?.path || !file.originalname || !file.mimetype) throw badRequest("请选择要导入的 xlsx 或 csv 文件");
  const stored = await storeUploadedFile(file.path, file.originalname, file.mimetype, document.id);
  let persisted = false;
  try {
    const updated = await withCollabTransaction(async (client) => {
      const locked = await client.query(
        "SELECT current_revision, storage_limit_bytes FROM collab.documents WHERE id = $1::uuid AND company_id = $2 AND status = 'active' FOR UPDATE",
        [document.id, auth.companyId]
      );
      if (!locked.rowCount) throw collabError(409, "COLLAB_DOCUMENT_ARCHIVED", "文档当前不可导入");
      assertDocumentFileSizeWithinLimit(locked.rows[0], stored.sizeBytes);
      const revision = Number(locked.rows[0].current_revision) + 1;
      const version = crypto.randomUUID();
      const nextVersion = await client.query(
        "SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM collab.document_versions WHERE document_id = $1::uuid",
        [document.id]
      );
      const versionNo = Number(nextVersion.rows[0].version_no);
      await client.query(
        `INSERT INTO collab.document_versions
          (id, document_id, version_no, revision, object_key, sha256, size_bytes, label, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, '导入文件', $8)`,
        [version, document.id, versionNo, revision, stored.objectKey, stored.sha256, stored.sizeBytes, auth.userId]
      );
      const result = await client.query(
        `UPDATE collab.documents SET source_object_key = $3, current_version_id = $4::uuid,
            current_revision = $5, updated_by = $6, updated_at = now()
          WHERE id = $1::uuid AND company_id = $2
          RETURNING id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
                    access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
                    created_by, updated_by, created_at, updated_at, deleted_at`,
        [document.id, auth.companyId, stored.objectKey, version, revision, auth.userId]
      );
      await recordCollabAudit(
        {
          documentId: document.id,
          companyId: auth.companyId,
          actorUserId: auth.userId,
          action: "document.imported",
          requestId,
          revision,
          metadata: { extension: stored.extension, sizeBytes: stored.sizeBytes },
        },
        client
      );
      return result.rows[0];
    });
    // 数据库事务提交后对象已成为当前版本引用，后续权限 DTO 失败不能清理它。
    persisted = true;
    const access = await getDocumentAccess(auth, updated, { pageAction: "query" });
    return documentDtoForAuth(auth, updated, access);
  } catch (error) {
    if (!persisted) await removeObject(stored.objectKey).catch(() => undefined);
    throw error;
  }
}

/**
 * 获取当前用户允许导出的文档文件及固定 MIME，路由层只负责设置响应头和发送已校验路径。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID。
 * @returns {Promise<{document: Record<string, unknown>, filePath: string, mimeType: string, fileName: string}>} 受控文件发送信息。
 * @throws {import("../lib/http-error").HttpError} 页面权限、文档 ACL 或文件不存在时抛出。
 */
async function getDocumentExport(auth, documentId, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  const access = await getDocumentAccess(auth, document, { pageAction: "export", require: "export" });
  if (!document.source_object_key) throw collabError(404, "COLLAB_FILE_NOT_FOUND", "文档当前没有可导出的文件");
  const filePath = await getExistingObjectPath(document.source_object_key);
  await recordCollabAudit({
    documentId: document.id,
    companyId: auth.companyId,
    actorUserId: auth.userId,
    action: "document.exported",
    requestId,
    revision: Number(document.current_revision),
    metadata: { role: access.role, format: document.source_object_key.endsWith(".csv") ? "csv" : "xlsx" },
  });
  const extension = document.source_object_key.toLowerCase().endsWith(".csv") ? "csv" : "xlsx";
  const fileName = `${document.name.replace(/\.[^.]{1,5}$/i, "")}.${extension}`;
  return { document, filePath, mimeType: mimeTypeForObjectKey(document.source_object_key), fileName };
}

/**
 * 供 Office 回调和签名文件服务读取当前 Company 文档，不向普通浏览器暴露内部数据库对象。
 * @param {string} companyId 当前 Company objectId。
 * @param {string} documentId 文档 UUID。
 * @param {boolean} [includeDeleted=false] 是否允许读取软删除文档。
 * @returns {Promise<Record<string, unknown>>} 文档数据库行。
 * @throws {import("../lib/http-error").HttpError} 文档不存在或数据库未就绪时抛出。
 */
async function getInternalDocument(companyId, documentId, includeDeleted = false) {
  return getTenantDocument(companyId, documentId, { includeDeleted });
}

/**
 * 获取当前用户可访问的单份文档详情。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @returns {Promise<Record<string, unknown>>} 文档安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 页面权限、文档 ACL 或数据库状态异常时抛出。
 */
async function getDocument(auth, documentId) {
  await assertCollabDatabaseReady();
  const document = await getTenantDocument(auth.companyId, documentId);
  const access = await getDocumentAccess(auth, document, { pageAction: "query" });
  return documentDtoForAuth(auth, document, access);
}

module.exports = {
  createDocument,
  queryDocuments,
  getDocument,
  updateDocument,
  softDeleteDocument,
  restoreDocument,
  importDocument,
  getDocumentExport,
  getInternalDocument,
};
