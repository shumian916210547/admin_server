"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const jwt = require("jsonwebtoken");

const { config } = require("../config/env");
const { badRequest, HttpError, unauthorized } = require("../lib/http-error");
const logger = require("../lib/logger");
const { queryCollab, withCollabTransaction } = require("./collab-database.service");
const {
  collabError,
  documentDtoForAuth,
  getDocumentAccess,
  getTenantDocument,
  normalizeDocumentId,
} = require("./collab-access.service");
const {
  CSV_MIME_TYPE,
  XLSX_MIME_TYPE,
  assertDocumentFileSizeWithinLimit,
  getExistingObjectPath,
  getTemporaryDirectory,
  mimeTypeForObjectKey,
  removeObject,
  storeUploadedFile,
} = require("./collab-storage.service");
const { recordCollabAudit } = require("./collab-audit.service");
const { getInternalDocument } = require("./collab-document.service");

const OFFICE_ISSUER = "shumian-collab-office";
const OFFICE_AUDIENCE = "office-document-server";
const OFFICE_FILE_TOKEN_TTL_SECONDS = 5 * 60;
const OFFICE_CALLBACK_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const SAVE_CALLBACK_STATUSES = new Set([2, 6]);
const NOOP_CALLBACK_STATUSES = new Set([1, 4]);

/**
 * 判断当前部署是否已配置可用的 ONLYOFFICE 地址和独立 JWT 密钥。
 * @returns {boolean} 浏览器地址、内部地址和签名密钥均存在时返回 true。
 */
function isOfficeConfigured() {
  return Boolean(config.collab.office.browserUrl && config.collab.office.jwtSecret);
}

/**
 * 使用独立 JWT 为 ONLYOFFICE 文件读取和回调签发服务端令牌；文件令牌短时有效，回调令牌覆盖一次工作日编辑窗口。
 * @param {{documentId: string, companyId: string, userId?: string, accessVersion: number, scope: "file" | "callback" | "editor"}} claims 文档、租户、当前 ACL 版本和用途声明。
 * @param {Record<string, unknown>} officePayload 可选的 ONLYOFFICE 标准配置声明；编辑器令牌需要包含 document.key 等字段。
 * @returns {string} 带用途、文档、租户和 ACL 版本声明的签名令牌；不返回给非 Office 配置的前端。
 * @throws {import("../lib/http-error").HttpError} Office 未配置时抛出 503。
 */
function signOfficeToken(claims, officePayload = {}) {
  if (!isOfficeConfigured()) throw new HttpError(503, "COLLAB_OFFICE_NOT_CONFIGURED", "协同编辑器尚未配置");
  const expiresIn = claims.scope === "callback" ? OFFICE_CALLBACK_TOKEN_TTL_SECONDS : OFFICE_FILE_TOKEN_TTL_SECONDS;
  return jwt.sign(
    {
      ...officePayload,
      documentId: claims.documentId,
      companyId: claims.companyId,
      userId: claims.userId,
      accessVersion: claims.accessVersion,
      scope: claims.scope,
    },
    config.collab.office.jwtSecret,
    { algorithm: "HS256", expiresIn, issuer: OFFICE_ISSUER, audience: OFFICE_AUDIENCE }
  );
}

/**
 * 校验 ONLYOFFICE 文件服务或回调使用的短时 JWT，拒绝缺失用途、文档或租户声明的令牌。
 * @param {unknown} token HTTP Authorization 或 URL query 中的 Office JWT。
 * @param {"file" | "callback"} scope 允许的令牌用途。
 * @returns {{documentId: string, companyId: string, userId?: string, scope: string}} 已校验的声明。
 * @throws {import("../lib/http-error").HttpError} 签名、时效、用途或字段非法时抛出 401/403。
 */
function verifyOfficeToken(token, scope) {
  if (!isOfficeConfigured() || typeof token !== "string" || !token) throw unauthorized("Office 令牌无效");
  try {
    const claims = jwt.verify(token, config.collab.office.jwtSecret, {
      algorithms: ["HS256"],
      issuer: OFFICE_ISSUER,
      audience: OFFICE_AUDIENCE,
    });
    if (claims.scope !== scope || typeof claims.documentId !== "string" || typeof claims.companyId !== "string") {
      throw new Error("invalid scope");
    }
    normalizeDocumentId(claims.documentId);
    return claims;
  } catch {
    throw unauthorized("Office 令牌无效或已过期");
  }
}

/**
 * 生成 ONLYOFFICE 编辑器所需配置；文档权限仍由 BFF 先行计算，Office 只接收最小权限集合。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {Record<string, unknown>} document 当前 Company 文档行。
 * @param {{role: string | null, canEdit: boolean, canComment: boolean, canExport: boolean}} access 当前用户文档 ACL。
 * @returns {Record<string, unknown>} 前端可初始化编辑器的配置或未配置原因。
 * @throws {import("../lib/http-error").HttpError} Office 配置不完整或文档文件缺失时抛出。
 */
function buildEditorConfig(auth, document, access) {
  if (!isOfficeConfigured()) {
    return {
      available: false,
      engine: document.engine,
      reason: "COLLAB_OFFICE_NOT_CONFIGURED",
      message: "当前环境尚未配置 ONLYOFFICE，文档管理和权限功能可用，编辑器需在部署后启用。",
    };
  }
  if (!document.source_object_key) throw collabError(404, "COLLAB_FILE_NOT_FOUND", "文档当前没有可编辑的文件");
  const fileToken = signOfficeToken({ documentId: document.id, companyId: auth.companyId, userId: auth.userId, accessVersion: document.access_version, scope: "file" });
  const callbackToken = signOfficeToken({ documentId: document.id, companyId: auth.companyId, userId: auth.userId, accessVersion: document.access_version, scope: "callback" });
  const extension = document.source_object_key.toLowerCase().endsWith(".csv") ? "csv" : "xlsx";
  const documentTitle = document.name.replace(/\.[^.]{1,5}$/i, "") + `.${extension}`;
  const baseUrl = config.publicOrigin;
  const officeConfig = {
    document: {
      fileType: extension,
      key: `${document.id}-${document.current_revision}-${document.access_version}`.slice(0, 120),
      title: documentTitle,
      url: `${baseUrl}/api/collab/office/files/${document.id}?token=${encodeURIComponent(fileToken)}`,
      permissions: {
        edit: access.canEdit === true,
        comment: access.canComment === true,
        download: access.canExport === true,
        print: false,
      },
    },
    documentType: "cell",
    editorConfig: {
      mode: access.canEdit ? "edit" : "view",
      // Fast 协同模式由 ONLYOFFICE 负责广播远程选区，并在悬停选区时显示配置中的成员姓名。
      lang: "zh",
      region: "zh-CN",
      coEditing: { mode: "fast", change: false },
      callbackUrl: `${baseUrl}/api/collab/office/callback/${document.id}?token=${encodeURIComponent(callbackToken)}`,
      user: { id: auth.userId, name: String(auth.user?.get?.("name") || auth.user?.get?.("username") || "当前成员") },
      customization: { compactHeader: true, feedback: false, forcesave: false },
    },
  };
  const editorToken = signOfficeToken(
    { documentId: document.id, companyId: auth.companyId, userId: auth.userId, accessVersion: document.access_version, scope: "editor" },
    officeConfig
  );
  return {
    available: true,
    engine: "onlyoffice",
    documentServerUrl: config.collab.office.browserUrl,
    token: editorToken,
    config: officeConfig,
  };
}

/**
 * 校验当前用户文档 ACL 并返回 ONLYOFFICE 初始化配置，未配置时明确降级而不是伪造实时编辑。
 * @param {Record<string, unknown>} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @returns {Promise<Record<string, unknown>>} 编辑器容器配置和当前权限。
 * @throws {import("../lib/http-error").HttpError} 页面权限、文档 ACL 或文件状态异常时抛出。
 */
async function getEditorConfig(auth, documentId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  const access = await getDocumentAccess(auth, document, { pageAction: "query" });
  const editor = buildEditorConfig(auth, document, access);
  return { document: await documentDtoForAuth(auth, document, access), editor };
}

/**
 * 从 ONLYOFFICE 回调 URL 下载保存后的工作簿；仅允许配置的 Office 服务主机，阻止 SSRF。
 * @param {string} fileUrl Office 回调中的保存文件 URL。
 * @returns {Promise<Buffer>} 下载到内存且未超过协同文件限制的内容。
 * @throws {import("../lib/http-error").HttpError} URL 主机不受信、响应过大或下载失败时抛出 400/503。
 */
async function downloadOfficeFile(fileUrl) {
  let parsed;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw badRequest("Office 回调文件地址无效");
  }
  const internalUrl = config.collab.office.internalUrl || config.collab.office.browserUrl;
  const trusted = new URL(internalUrl);
  if (parsed.origin !== trusted.origin || parsed.username || parsed.password) {
    throw badRequest("Office 回调文件地址不在受信服务范围内");
  }
  try {
    const response = await axios.get(parsed.toString(), {
      responseType: "arraybuffer",
      timeout: 30_000,
      maxContentLength: config.collab.maxFileBytes,
      maxBodyLength: config.collab.maxFileBytes,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length > config.collab.maxFileBytes) throw new Error("file too large");
    return buffer;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "COLLAB_OFFICE_CALLBACK_FAILED", "Office 保存文件暂时无法获取");
  }
}

/**
 * 处理 ONLYOFFICE 保存回调，验证令牌和文档关系后以幂等新版本保存工作簿。
 * @param {unknown} documentId URL 中的文档 UUID。
 * @param {unknown} token 短时 callback JWT。
 * @param {Record<string, unknown>} body Office 回调 JSON，包含 status 和保存文件 url。
 * @param {string | undefined} requestId 当前请求 ID。
 * @returns {Promise<{error: number}>} ONLYOFFICE 要求的固定响应；error 为 0 表示确认。
 * @throws {import("../lib/http-error").HttpError} 令牌、回调状态、文档或文件校验失败时抛出。
 */
async function handleOfficeCallback(documentId, token, body, requestId) {
  const normalizedId = normalizeDocumentId(documentId);
  const claims = verifyOfficeToken(token, "callback");
  if (claims.documentId.toLowerCase() !== normalizedId) throw unauthorized("Office 文档令牌不匹配");
  const status = Number(body?.status);
  logger.info("collab.office.callback.received", {
    documentId: normalizedId,
    status,
    hasFileUrl: typeof body?.url === "string" && body.url.length > 0,
  });
  if (NOOP_CALLBACK_STATUSES.has(status)) return { error: 0 };
  if (!SAVE_CALLBACK_STATUSES.has(status)) return { error: 1 };
  if (typeof body?.url !== "string" || body.url.length > 2_048) throw badRequest("Office 保存回调缺少文件地址");

  const currentDocument = await getInternalDocument(claims.companyId, normalizedId);
  if (
    currentDocument.status !== "active" ||
    Number(currentDocument.access_version) !== Number(claims.accessVersion) ||
    !currentDocument.source_object_key
  ) {
    throw unauthorized("Office 文档不可用");
  }
  const extension = currentDocument.source_object_key.toLowerCase().endsWith(".csv") ? "csv" : "xlsx";
  const callbackFileName = `office-callback.${extension}`;
  const callbackMimeType = extension === "csv" ? CSV_MIME_TYPE : XLSX_MIME_TYPE;
  const buffer = await downloadOfficeFile(body.url);
  assertDocumentFileSizeWithinLimit(currentDocument, buffer.length);
  const temporaryPath = path.join(getTemporaryDirectory(), `office-${crypto.randomUUID()}.${extension}`);
  await fs.promises.writeFile(temporaryPath, buffer, { flag: "wx" });
  let stored;
  try {
    stored = await storeUploadedFile(
      temporaryPath,
      callbackFileName,
      callbackMimeType,
      normalizedId,
      "sources"
    );
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
  }

  let duplicate = false;
  try {
    await withCollabTransaction(async (client) => {
      const locked = await client.query(
        `SELECT company_id, owner_user_id, current_revision, source_object_key, access_version, status, storage_limit_bytes
           FROM collab.documents WHERE id = $1::uuid FOR UPDATE`,
        [normalizedId]
      );
      const document = locked.rows[0];
      if (!document || document.company_id !== claims.companyId || document.status !== "active" || Number(document.access_version) !== Number(claims.accessVersion)) {
        throw unauthorized("Office 文档不可用");
      }
      assertDocumentFileSizeWithinLimit(document, stored.sizeBytes);
      const existing = await client.query(
        "SELECT sha256 FROM collab.document_versions WHERE document_id = $1::uuid ORDER BY version_no DESC LIMIT 1",
        [normalizedId]
      );
      if (existing.rows[0]?.sha256 === stored.sha256) {
        duplicate = true;
        return;
      }
      const nextVersion = await client.query(
        "SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM collab.document_versions WHERE document_id = $1::uuid",
        [normalizedId]
      );
      const versionId = crypto.randomUUID();
      const revision = Number(document.current_revision) + 1;
      const versionNo = Number(nextVersion.rows[0].version_no);
      await client.query(
        `INSERT INTO collab.document_versions
          (id, document_id, version_no, revision, object_key, sha256, size_bytes, label, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, '自动保存', $8)`,
        [versionId, normalizedId, versionNo, revision, stored.objectKey, stored.sha256, stored.sizeBytes, claims.userId || document.owner_user_id]
      );
      await client.query(
        `UPDATE collab.documents SET source_object_key = $2, current_version_id = $3::uuid,
          current_revision = $4, updated_by = $5, updated_at = now()
          WHERE id = $1::uuid`,
        [normalizedId, stored.objectKey, versionId, revision, claims.userId || document.owner_user_id]
      );
      await recordCollabAudit(
        {
          documentId: normalizedId,
          companyId: document.company_id,
          actorUserId: claims.userId || document.owner_user_id,
          action: "office.callback.saved",
          requestId,
          revision,
          metadata: { versionNo, sizeBytes: stored.sizeBytes },
        },
        client
      );
    });
  } catch (error) {
    await removeObject(stored.objectKey).catch(() => undefined);
    throw error;
  }
  if (duplicate) await removeObject(stored.objectKey).catch(() => undefined);
  return { error: 0 };
}

/**
 * 提供给 Office 文件读取路由的受控文件信息，令牌声明决定文档和 Company 边界。
 * @param {unknown} documentId URL 中的文档 UUID。
 * @param {unknown} token 短时 file JWT。
 * @returns {Promise<{filePath: string, mimeType: string, document: Record<string, unknown>}>} 受控文件发送信息。
 * @throws {import("../lib/http-error").HttpError} 令牌不匹配、文档状态无效或文件不存在时抛出。
 */
async function getOfficeFile(documentId, token) {
  const normalizedId = normalizeDocumentId(documentId);
  const claims = verifyOfficeToken(token, "file");
  if (claims.documentId.toLowerCase() !== normalizedId) throw unauthorized("Office 文档令牌不匹配");
  const document = await getInternalDocument(claims.companyId, normalizedId);
  if (
    !["active", "archived"].includes(document.status) ||
    Number(document.access_version) !== Number(claims.accessVersion) ||
    !document.source_object_key
  ) {
    throw unauthorized("Office 文档令牌已失效");
  }
  const filePath = await getExistingObjectPath(document.source_object_key);
  return { document, filePath, mimeType: mimeTypeForObjectKey(document.source_object_key) };
}

module.exports = {
  isOfficeConfigured,
  signOfficeToken,
  verifyOfficeToken,
  getEditorConfig,
  handleOfficeCallback,
  getOfficeFile,
};
