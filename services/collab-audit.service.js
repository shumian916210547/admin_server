"use strict";

const { queryCollab } = require("./collab-database.service");

/**
 * 写入协同领域审计事件；元数据只允许由服务端构造，禁止记录文件内容、令牌和完整下载地址。
 * @param {{documentId?: string | null, companyId: string, actorUserId?: string | null, action: string, requestId?: string, revision?: number | null, metadata?: Record<string, unknown>}} event 审计事件字段。
 * @param {import("pg").PoolClient | undefined} [client] 可选事务客户端；提供时与业务写入原子提交。
 * @returns {Promise<void>} 审计事件写入完成后兑现。
 * @throws {Error} 审计写入失败时抛出，调用方应回滚同一事务或返回错误。
 */
async function recordCollabAudit(event, client) {
  const runQuery = client
    ? (text, params) => client.query(text, params)
    : (text, params) => queryCollab(text, params);
  await runQuery(
    `INSERT INTO collab.document_audit_events
      (document_id, company_id, actor_user_id, action, request_id, revision, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      event.documentId || null,
      event.companyId,
      event.actorUserId || null,
      event.action,
      event.requestId || null,
      event.revision === undefined ? null : event.revision,
      JSON.stringify(event.metadata || {}),
    ]
  );
}

module.exports = { recordCollabAudit };
