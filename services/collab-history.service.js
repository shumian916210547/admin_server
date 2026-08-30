"use strict";

const { badRequest } = require("../lib/http-error");
const { queryCollab } = require("./collab-database.service");
const {
  getDocumentAccess,
  getTenantDocument,
  listActiveTenantUsers,
  normalizeDocumentId,
} = require("./collab-access.service");

const MAX_ACTIVITY_PAGE_SIZE = 100;

/**
 * 规范化文档活动记录分页参数，避免历史查询一次性扫描或返回过大的结果集。
 * @param {Record<string, unknown> | undefined} query URL 查询参数；page/pageSize 缺失时使用安全默认值。
 * @returns {{page: number, pageSize: number}} 经过范围校验的页码和每页数量。
 * @throws {import("../lib/http-error").HttpError} 页码不是正整数或超过单页上限时抛出 400。
 */
function normalizeActivityQuery(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 50 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw badRequest("修改记录页码格式无效");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_ACTIVITY_PAGE_SIZE) {
    throw badRequest(`修改记录每页数量必须是 1 到 ${MAX_ACTIVITY_PAGE_SIZE}`);
  }
  return { page, pageSize };
}

/**
 * 将审计数据库行转换为修改记录 DTO，不返回请求 ID、对象存储路径或文件内容。
 * @param {Record<string, unknown>} event 审计事件数据库行。
 * @param {Map<string, string>} peopleById 当前 Company 内的成员名称索引。
 * @returns {Record<string, unknown>} 可供历史面板展示的安全修改记录。
 */
function activityDto(event, peopleById) {
  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
  const revision = event.revision === null || event.revision === undefined ? null : Number(event.revision);
  return {
    id: String(event.id),
    action: event.action,
    actorUserId: event.actor_user_id || null,
    actorName: event.actor_user_id ? peopleById.get(event.actor_user_id) || "已离职成员" : "系统",
    revision: Number.isFinite(revision) ? revision : null,
    metadata,
    createdAt: new Date(event.created_at).toISOString(),
  };
}

/**
 * 查询当前用户有权查看的文档修改记录；Office 每次成功保存、导入、恢复和配置变更均由审计表追加记录。
 * @param {{companyId: string, userId: string, user?: import("parse/node").User, isAdmin?: boolean, roleId?: string, role?: import("parse/node").Object}} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {Record<string, unknown>} query 分页参数。
 * @returns {Promise<{documentId: string, events: Array<Record<string, unknown>>, count: number, page: number, pageSize: number}>} 修改记录分页结果。
 * @throws {import("../lib/http-error").HttpError} 文档标识、页面历史权限或租户 ACL 不满足时抛出。
 */
async function listDocumentActivity(auth, documentId, query) {
  const normalizedId = normalizeDocumentId(documentId);
  const document = await getTenantDocument(auth.companyId, normalizedId);
  await getDocumentAccess(auth, document, { pageAction: "history" });
  const input = normalizeActivityQuery(query);
  const countResult = await queryCollab(
    `SELECT COUNT(*)::int AS count
       FROM collab.document_audit_events
      WHERE document_id = $1::uuid AND company_id = $2`,
    [normalizedId, auth.companyId]
  );
  const offset = (input.page - 1) * input.pageSize;
  const eventsResult = await queryCollab(
    `SELECT id, action, actor_user_id, revision, metadata, created_at
       FROM collab.document_audit_events
      WHERE document_id = $1::uuid AND company_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [normalizedId, auth.companyId, input.pageSize, offset]
  );
  const actorIds = [...new Set(eventsResult.rows.map((event) => event.actor_user_id).filter(Boolean))];
  const users = await listActiveTenantUsers(auth.companyId, actorIds);
  const peopleById = new Map(
    users.map((user) => [
      user.id,
      String(user.get("name") || user.get("nickname") || user.get("username") || "未命名成员"),
    ])
  );
  return {
    documentId: normalizedId,
    events: eventsResult.rows.map((event) => activityDto(event, peopleById)),
    count: Number(countResult.rows[0]?.count || 0),
    page: input.page,
    pageSize: input.pageSize,
  };
}

module.exports = { listDocumentActivity };
