"use strict";

const Parse = require("parse/node");

const { config } = require("../config/env");
const { badRequest, forbidden, HttpError } = require("../lib/http-error");
const { master, pointer } = require("./parse-data.service");
const {
  assertCollabDatabaseReady,
  queryCollab,
  withCollabTransaction,
} = require("./collab-database.service");

const COLLAB_PAGE_SYSTEM_KEY = "collab.spreadsheet";
const PAGE_ACTIONS = new Set(["query", "insert", "edit", "remove", "import", "export", "share", "history"]);
const DOCUMENT_ROLES = new Set(["owner", "editor", "commenter", "viewer"]);
const MEMBER_ROLES = new Set(["editor", "commenter", "viewer"]);
const ACCESS_MODES = new Set(["members", "company_public"]);
const DOCUMENT_STATUSES = new Set(["active", "archived", "deleted"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_NAME_LENGTH = 200;
const MAX_MEMBER_COUNT = 100;
const MAX_MEMBER_OPTION_COUNT = 200;
const MAX_ORGANIZATION_COUNT = 10_000;

/**
 * 创建带协同领域错误码的 HTTP 错误，避免把数据库结构或 Parse 查询细节暴露给浏览器。
 * @param {number} status HTTP 状态码。
 * @param {string} code 稳定的 COLLAB_ 前缀业务错误码。
 * @param {string} message 面向用户的简体中文提示。
 * @param {unknown} [details] 可选的安全诊断信息；不得包含令牌、SQL 或文件内容。
 * @returns {import("../lib/http-error").HttpError} 业务错误实例。
 */
function collabError(status, code, message, details) {
  return new HttpError(status, code, message, details);
}

/**
 * 规范化 Parse objectId，拒绝把任意 URL 文本带入租户或成员查询。
 * @param {unknown} value URL 或请求体中的 Parse objectId。
 * @param {string} label 错误提示使用的字段名称。
 * @param {boolean} [required=true] 是否必须提供该值。
 * @returns {string | null} 合法 objectId；非必填值缺失时返回 null。
 * @throws {import("../lib/http-error").HttpError} 标识缺失或格式不安全时抛出 400。
 */
function normalizeObjectId(value, label, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw badRequest(`${label}不能为空`);
    return null;
  }
  if (typeof value !== "string" || !ID_PATTERN.test(value.trim())) {
    throw badRequest(`${label}格式无效`);
  }
  return value.trim();
}

/**
 * 规范化协同文档 UUID，防止把 SQL 标识符或任意路径片段作为文档条件。
 * @param {unknown} value URL 中的文档标识。
 * @returns {string} 小写文档 UUID。
 * @throws {import("../lib/http-error").HttpError} 文档标识不是 UUID 时抛出 400。
 */
function normalizeDocumentId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw badRequest("文档标识格式无效");
  }
  return value.trim().toLowerCase();
}

/**
 * 将 Parse Object、Pointer JSON 或安全 DTO 转换为 objectId。
 * @param {unknown} value 可能包含 id/objectId 的关联值。
 * @returns {string | null} 提取到的标识；无法提取时返回 null。
 */
function pointerId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || value.objectId || null;
}

/**
 * 从成员用户资料提取有效组织范围根节点；组织数据权限优先于普通关联组织，兼容旧版单组织字段。
 * @param {Parse.User | Record<string, unknown>} user Parse 用户或其服务端资料对象。
 * @returns {string[]} 去重后的组织 objectId 列表。
 */
function userOrganizationIds(user) {
  const associatedIds = Array.isArray(user?.get?.("organizationIds"))
    ? user.get("organizationIds")
    : user?.organizationIds || [];
  const scopeIds = Array.isArray(user?.get?.("organizationScopes"))
    ? user.get("organizationScopes")
    : user?.organizationScopes || [];
  const primaryId = user?.get?.("organization") || user?.organization;
  const values = scopeIds.length ? scopeIds : associatedIds.length ? associatedIds : [primaryId];
  return [...new Set(values.map(pointerId).filter((id) => typeof id === "string" && ID_PATTERN.test(id)))];
}

/**
 * 查询当前 Company 的启用组织树，所有组织范围判断都以服务端真实记录为准。
 * @param {string} companyId 当前认证上下文中的 Company objectId。
 * @returns {Promise<Parse.Object[]>} 当前企业组织记录，最多 MAX_ORGANIZATION_COUNT 条。
 * @throws {Error} Parse 查询失败时抛出，调用方不得放宽访问范围。
 */
async function listTenantOrganizations(companyId) {
  const query = new Parse.Query("Organization");
  query.equalTo("company", pointer("Company", companyId));
  query.equalTo("isActive", true);
  query.limit(MAX_ORGANIZATION_COUNT);
  return query.find(master);
}

/**
 * 将用户配置的组织根节点展开为其所有启用后代节点。
 * @param {Parse.Object[]} organizations 当前 Company 的组织记录。
 * @param {string[]} roots 用户被授予的组织根节点 objectId。
 * @returns {Set<string>} 用户可使用的组织 objectId 集合。
 */
function expandOrganizationIds(organizations, roots) {
  const organizationIds = new Set(organizations.map((organization) => organization.id).filter(Boolean));
  const childrenByParent = new Map();
  for (const organization of organizations) {
    const parentId = pointerId(organization.get("parent"));
    if (!childrenByParent.has(parentId || "")) childrenByParent.set(parentId || "", []);
    childrenByParent.get(parentId || "").push(organization.id);
  }
  const result = new Set();
  const pending = [...roots];
  while (pending.length) {
    const current = pending.shift();
    if (!current || result.has(current) || !organizationIds.has(current)) continue;
    result.add(current);
    pending.push(...(childrenByParent.get(current) || []));
  }
  return result;
}

/**
 * 计算用户可用于文档组织范围匹配的组织集合；用户范围向下覆盖子组织，文档范围向上兼容父组织限定。
 * @param {Parse.Object[]} organizations 当前 Company 的启用组织树。
 * @param {Parse.User | Record<string, unknown>} user 需要判断的真实 Company 成员。
 * @returns {Set<string>} 用户组织范围及其所有祖先组织的 objectId 集合。
 */
function userDocumentOrganizationIds(organizations, user) {
  const parentById = new Map(
    organizations
      .map((organization) => [organization.id, pointerId(organization.get("parent"))])
      .filter(([organizationId]) => Boolean(organizationId))
  );
  const result = expandOrganizationIds(organizations, userOrganizationIds(user));
  for (const organizationId of [...result]) {
    let parentId = parentById.get(organizationId);
    while (parentId && !result.has(parentId)) {
      result.add(parentId);
      parentId = parentById.get(parentId);
    }
  }
  return result;
}

/**
 * 判断用户是否在指定文档组织范围内；空组织范围表示 Company 内所有有效成员可访问。
 * @param {Parse.User} user 待判断的真实 Company 成员。
 * @param {string | null} organizationId 文档组织范围 objectId，可为空。
 * @param {string} companyId 当前 Company objectId。
 * @returns {Promise<boolean>} 用户组织或数据权限落在文档组织及其下级时返回 true。
 * @throws {Error} 组织树读取失败时抛出，调用方应安全失败。
 */
async function isUserInOrganizationScope(user, organizationId, companyId) {
  if (!organizationId) return true;
  const organizations = await listTenantOrganizations(companyId);
  const organizationIds = userDocumentOrganizationIds(organizations, user);
  return organizationIds.has(organizationId);
}

/**
 * 判断目标成员的所有组织范围根节点是否落在操作者授权范围内，用于限制普通 owner 的跨组织分享。
 * @param {Parse.User} actor 当前文档操作者的真实用户记录。
 * @param {Parse.User} target 待授权的当前 Company 有效成员。
 * @param {string} companyId 当前 Company objectId。
 * @returns {Promise<boolean>} 目标成员的组织根节点全部位于操作者范围内时返回 true。
 * @throws {Error} 组织树读取失败时抛出，调用方应拒绝本次授权。
 */
async function isUserWithinActorScope(actor, target, companyId) {
  const organizations = await listTenantOrganizations(companyId);
  const actorIds = expandOrganizationIds(organizations, userOrganizationIds(actor));
  const targetRoots = userOrganizationIds(target);
  if (!actorIds.size || !targetRoots.length) return false;
  return targetRoots.every((organizationId) => actorIds.has(organizationId));
}

/**
 * 加载当前 Company 内状态可用的成员，永远不接受客户端 companyId 作为查询边界。
 * @param {string} companyId 认证上下文中的 Company objectId。
 * @param {string[]} userIds 需要加载的用户 objectId 列表。
 * @returns {Promise<Parse.User[]>} 仍属于当前企业且未停用的成员记录。
 * @throws {Error} Parse 查询失败时抛出。
 */
async function listActiveTenantUsers(companyId, userIds) {
  if (!userIds.length) return [];
  const query = new Parse.Query(Parse.User);
  query.equalTo("company", pointer("Company", companyId));
  query.containedIn("objectId", userIds);
  query.notEqualTo("isDelete", true);
  query.limit(MAX_MEMBER_OPTION_COUNT);
  return query.find(master);
}

/**
 * 加载单个当前企业成员，作为成员授权和分享对象的服务端事实来源。
 * @param {string} companyId 当前 Company objectId。
 * @param {string} userId 待查询的成员 objectId。
 * @returns {Promise<Parse.User | null>} 有效成员记录；不存在、停用或跨租户时返回 null。
 * @throws {Error} Parse 查询失败时抛出。
 */
async function findActiveTenantUser(companyId, userId) {
  const users = await listActiveTenantUsers(companyId, [userId]);
  return users[0] || null;
}

/**
 * 读取当前角色在协同表格页面上的有效按钮权限；系统管理员由服务端认证上下文直接放行。
 * @param {{companyId: string, userId: string, roleId?: string | null, role?: Parse.Object, isAdmin?: boolean}} auth 可信认证上下文。
 * @returns {Promise<{route: Parse.Object | null, actions: Set<string>}>} 页面 Route 和最终生效的动作集合；管理员包含全部协同动作。
 * @throws {import("../lib/http-error").HttpError} 页面未配置、岗位缺失或 Parse 查询失败时抛出 403 或原始错误。
 */
async function getCollabPagePermissions(auth) {
  if (auth?.isAdmin) return { route: null, actions: new Set(PAGE_ACTIONS) };
  if (!auth?.companyId || !auth?.roleId) throw forbidden("当前岗位未配置协同表格权限");

  const routeQuery = new Parse.Query("Route");
  routeQuery.equalTo("company", pointer("Company", auth.companyId));
  routeQuery.equalTo("systemKey", COLLAB_PAGE_SYSTEM_KEY);
  const route = await routeQuery.first(master);
  if (!route) throw forbidden("协同表格页面尚未配置权限");

  if (auth.role?.get("positionManaged") === true) {
    const moduleIds = new Set((auth.role.get("module") || []).map(pointerId).filter(Boolean));
    if (!moduleIds.has(route.id)) throw forbidden();
  }

  const permissionQuery = new Parse.Query("AllotPermission");
  permissionQuery.equalTo("company", pointer("Company", auth.companyId));
  permissionQuery.equalTo("role", pointer("Role", auth.roleId));
  permissionQuery.containedIn("routes", [pointer("Route", route.id)]);
  permissionQuery.limit(100);
  const records = await permissionQuery.find(master);
  const managed = records.filter((record) => record.get("positionManaged") === true);
  const effectiveRecords = managed.length ? managed : records;
  const actions = new Set();
  for (const record of effectiveRecords) {
    const routePermissions = record.get("routePermissions");
    const permissions = Array.isArray(routePermissions?.[route.id])
      ? routePermissions[route.id]
      : record.get("permissions") || [];
    if (!Array.isArray(permissions)) continue;
    for (const action of PAGE_ACTIONS) {
      if (permissions.includes(`permission:${action}`)) actions.add(action);
    }
  }
  return { route, actions };
}

/**
 * 校验当前角色是否拥有协同表格页面上的指定按钮权限；系统管理员由服务端认证上下文直接放行。
 * @param {{companyId: string, userId: string, roleId?: string | null, role?: Parse.Object, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {string} action 页面动作名称，不含 permission: 前缀。
 * @returns {Promise<Parse.Object | null>} 匹配的 Route 记录；管理员放行时返回 null。
 * @throws {import("../lib/http-error").HttpError} 动作非法、页面未配置或角色未授权时抛出 400/403。
 */
async function assertCollabPagePermission(auth, action) {
  if (!PAGE_ACTIONS.has(action)) throw badRequest("协同表格操作类型无效");
  const { route, actions } = await getCollabPagePermissions(auth);
  if (!actions.has(action)) throw forbidden();
  return route;
}

/**
 * 读取当前租户的文档元数据，并阻止跨租户、非法状态或不存在文档被继续处理。
 * @param {string} companyId 当前认证上下文中的 Company objectId。
 * @param {unknown} documentId URL 中的文档 UUID。
 * @param {{includeDeleted?: boolean}} [options] 是否允许读取已软删除文档。
 * @returns {Promise<Record<string, unknown>>} PostgreSQL 文档行。
 * @throws {import("../lib/http-error").HttpError} 文档不存在、跨租户或状态不允许时抛出 404。
 */
async function getTenantDocument(companyId, documentId, options = {}) {
  await assertCollabDatabaseReady();
  const normalizedId = normalizeDocumentId(documentId);
  const result = await queryCollab(
    `SELECT id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
            access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
            (SELECT size_bytes FROM collab.document_versions AS current_version
              WHERE current_version.id = documents.current_version_id) AS file_size_bytes,
            created_by, updated_by, created_at, updated_at, deleted_at
       FROM collab.documents AS documents
      WHERE id = $1::uuid AND company_id = $2${options.includeDeleted ? "" : " AND status <> 'deleted'"}`,
    [normalizedId, companyId]
  );
  const document = result.rows[0];
  if (!document) throw collabError(404, "COLLAB_DOCUMENT_NOT_FOUND", "文档不存在或不属于当前企业");
  return document;
}

/**
 * 查询文档成员当前状态，未授权成员不会被当作有效 ACL。
 * @param {string} documentId 文档 UUID。
 * @param {string} userId 当前用户 objectId。
 * @returns {Promise<Record<string, unknown> | null>} 有效成员行；不存在或 revoked 时返回 null。
 * @throws {Error} 数据库查询失败时抛出。
 */
async function getActiveDocumentMember(documentId, userId) {
  const result = await queryCollab(
    `SELECT document_id, user_id, role, status, can_download, granted_by, created_at, updated_at
       FROM collab.document_members
      WHERE document_id = $1::uuid AND user_id = $2 AND status = 'active'`,
    [documentId, userId]
  );
  return result.rows[0] || null;
}

/**
 * 计算当前用户在文档上的最终 ACL，页面权限与文档权限必须同时满足。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {Record<string, unknown>} document 已通过当前 Company 查询的文档行。
 * @param {{pageAction?: string, require?: "read" | "edit" | "share" | "export", allowDeleted?: boolean}} [options] 页面动作及资源动作要求。
 * @returns {Promise<{document: Record<string, unknown>, role: string | null, canRead: boolean, canEdit: boolean, canComment: boolean, canShare: boolean, canExport: boolean, canHistory: boolean, member: Record<string, unknown> | null}>} ACL 结果；文档容量由 document.storage_limit_bytes 表示。
 * @throws {import("../lib/http-error").HttpError} 页面权限、组织范围或文档 ACL 不满足时抛出对应 COLLAB 错误。
 */
async function getDocumentAccess(auth, document, options = {}) {
  const pageAction = options.pageAction || "query";
  if (!PAGE_ACTIONS.has(pageAction)) throw badRequest("协同表格操作类型无效");
  const pagePermissions = await getCollabPagePermissions(auth);
  if (!pagePermissions.actions.has(pageAction)) throw forbidden();
  if (document.status === "deleted" && !options.allowDeleted) {
    throw collabError(404, "COLLAB_DOCUMENT_NOT_FOUND", "文档不存在或已删除");
  }
  const member = await getActiveDocumentMember(document.id, auth.userId);
  const isOwner = document.owner_user_id === auth.userId;
  const inOrganizationScope = auth.isAdmin || (await isUserInOrganizationScope(auth.user, document.organization_id, auth.companyId));
  const canRead = Boolean(
    pagePermissions.actions.has("query") &&
      inOrganizationScope &&
      (auth.isAdmin || isOwner || member || document.access_mode === "company_public")
  );
  const role = auth.isAdmin ? "admin" : isOwner ? "owner" : member?.role || (canRead ? "viewer" : null);
  const canEdit = Boolean(
    pagePermissions.actions.has("edit") &&
      canRead &&
      document.status === "active" &&
      (auth.isAdmin || isOwner || member?.role === "editor")
  );
  const canComment = Boolean(
    pagePermissions.actions.has("edit") &&
      canRead &&
      (auth.isAdmin || isOwner || member?.role === "editor" || member?.role === "commenter")
  );
  const canShare = Boolean(
    pagePermissions.actions.has("share") &&
      canRead &&
      (document.status !== "deleted" || options.allowDeleted) &&
      (auth.isAdmin || isOwner)
  );
  const canExport = Boolean(
    pagePermissions.actions.has("export") &&
      canRead &&
      document.status === "active" &&
      document.allow_download === true &&
      (auth.isAdmin || isOwner || member?.can_download === true)
  );
  const canHistory = Boolean(pagePermissions.actions.has("history") && canRead);

  const result = { document, role, canRead, canEdit, canComment, canShare, canExport, canHistory, member: member || null };
  if (!canRead) throw collabError(403, "COLLAB_ACCESS_DENIED", "没有访问此文档的权限");
  if (options.require === "edit" && !canEdit) throw collabError(403, "COLLAB_EDIT_DENIED", "没有编辑此文档的权限");
  if (options.require === "share" && !canShare) throw collabError(403, "COLLAB_SHARE_DENIED", "只有文档创建者可以管理分享权限");
  if (options.require === "export" && !canExport) throw collabError(403, "COLLAB_EXPORT_DENIED", "当前文档不允许导出或下载");
  return result;
}

/**
 * 把数据库文档行和用户 ACL 转换为前端可消费的安全 DTO，不返回数据库 URI 或对象存储物理路径。
 * @param {Record<string, unknown>} document PostgreSQL 文档行。
 * @param {{role?: string | null, canRead?: boolean, canEdit?: boolean, canComment?: boolean, canShare?: boolean, canExport?: boolean, canHistory?: boolean}} [access] 当前用户 ACL 摘要。
 * @param {Map<string, {userId: string, username: string, name: string, email: string>} } [peopleById] 当前 Company 内用户安全资料索引。
 * @returns {Record<string, unknown>} 文档列表或详情 DTO，包含 storageUsedBytes 与 storageLimitBytes 容量摘要。
 */
function documentDto(document, access = {}, peopleById = new Map()) {
  const creator = peopleById.get(document.created_by);
  const owner = peopleById.get(document.owner_user_id);
  const updatedBy = peopleById.get(document.updated_by);
  const parsedSize = Number(document.file_size_bytes);
  return {
    id: document.id,
    name: document.name,
    engine: document.engine,
    accessMode: document.access_mode,
    organizationId: document.organization_id || null,
    status: document.status,
    accessVersion: Number(document.access_version),
    currentRevision: Number(document.current_revision),
    currentVersionId: document.current_version_id || null,
    allowDownload: document.allow_download === true,
    storageLimitBytes: document.storage_limit_bytes === null || document.storage_limit_bytes === undefined
      ? null
      : Number(document.storage_limit_bytes),
    ownerUserId: document.owner_user_id,
    ownerName: owner?.name || "已离职成员",
    createdBy: document.created_by,
    createdByName: creator?.name || "已离职成员",
    updatedBy: document.updated_by,
    updatedByName: updatedBy?.name || "已离职成员",
    fileSizeBytes: Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : 0,
    storageUsedBytes: Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : 0,
    createdAt: new Date(document.created_at).toISOString(),
    updatedAt: new Date(document.updated_at).toISOString(),
    deletedAt: document.deleted_at ? new Date(document.deleted_at).toISOString() : null,
    permission: {
      role: access.role || null,
      canRead: access.canRead === true,
      canEdit: access.canEdit === true,
      canComment: access.canComment === true,
      canShare: access.canShare === true,
      canExport: access.canExport === true,
      canHistory: access.canHistory === true,
    },
  };
}

/**
 * 批量读取文档相关用户的脱敏资料，保证创建者和所有者名称只来自当前 Company 的服务端用户记录。
 * @param {string} companyId 当前认证上下文中的 Company objectId。
 * @param {Record<string, unknown> | Array<Record<string, unknown>>} documents 一个或多个已通过租户校验的文档行。
 * @returns {Promise<Map<string, {userId: string, username: string, name: string, email: string}>>} 用户 objectId 到安全资料的索引。
 * @throws {Error} Parse 用户查询失败时抛出，调用方不得使用客户端传入的名称替代。
 */
async function getDocumentPeopleMap(companyId, documents) {
  const rows = Array.isArray(documents) ? documents : [documents];
  const userIds = [
    ...new Set(
      rows
        .flatMap((document) => [document?.created_by, document?.owner_user_id, document?.updated_by])
        .filter((userId) => typeof userId === "string" && userId)
    ),
  ];
  const users = await listActiveTenantUsers(companyId, userIds);
  return new Map(users.map((user) => [user.id, memberOptionDto(user)]));
}

/**
 * 为服务端认证上下文构造完整文档 DTO，补齐当前版本大小和当前 Company 内的用户显示名称。
 * @param {{companyId: string}} auth 可信认证上下文，Company 只取服务端会话。
 * @param {Record<string, unknown>} document 已通过租户校验的文档行。
 * @param {{role?: string | null, canRead?: boolean, canEdit?: boolean, canComment?: boolean, canShare?: boolean, canExport?: boolean, canHistory?: boolean}} [access] 当前用户 ACL 摘要。
 * @returns {Promise<Record<string, unknown>>} 可供列表、编辑器和权限面板使用的文档安全 DTO。
 * @throws {Error} 用户资料或版本大小查询失败时抛出，避免返回不完整的元数据。
 */
async function documentDtoForAuth(auth, document, access = {}) {
  let source = document;
  if (source.file_size_bytes === undefined) {
    const result = await queryCollab(
      "SELECT size_bytes AS file_size_bytes FROM collab.document_versions WHERE id = $1::uuid",
      [source.current_version_id]
    );
    source = { ...source, file_size_bytes: result.rows[0]?.file_size_bytes || 0 };
  }
  const peopleById = await getDocumentPeopleMap(auth.companyId, source);
  return documentDto(source, access, peopleById);
}

/**
 * 检查请求中的访问模式、文档状态和文件下载开关，供文档创建与更新共用。
 * @param {unknown} value 请求体中的 accessMode 文本。
 * @returns {"members" | "company_public"} 规范化访问模式。
 * @throws {import("../lib/http-error").HttpError} 访问模式不在白名单时抛出 400。
 */
function normalizeAccessMode(value) {
  const accessMode = value === undefined ? "members" : value;
  if (typeof accessMode !== "string" || !ACCESS_MODES.has(accessMode)) {
    throw badRequest("访问模式只能是指定成员或企业内公开");
  }
  return accessMode;
}

/**
 * 校验文档名称，拒绝路径分隔符、控制字符和过长文本。
 * @param {unknown} value 请求体中的文档名称。
 * @returns {string} 去除首尾空格后的文档名称。
 * @throws {import("../lib/http-error").HttpError} 名称为空、超长或包含路径/控制字符时抛出 400。
 */
function normalizeDocumentName(value) {
  if (typeof value !== "string") throw badRequest("文档名称不能为空");
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest(`文档名称不能为空且不能超过${MAX_NAME_LENGTH}个字符`);
  }
  return name;
}

/**
 * 校验布尔字段，避免 JavaScript 真值转换把任意字符串当作下载权限。
 * @param {unknown} value 请求体中的布尔值。
 * @param {boolean} fallback 字段省略时的默认值。
 * @returns {boolean} 规范化后的布尔值。
 * @throws {import("../lib/http-error").HttpError} 显式值不是 boolean 时抛出 400。
 */
function normalizeBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw badRequest("字段必须是布尔值");
  return value;
}

/**
 * 校验乐观锁版本号，确保 ACL 更新不会覆盖其他操作者的最新修改。
 * @param {unknown} value 请求体中的 expectedAccessVersion。
 * @returns {number} 正整数访问版本。
 * @throws {import("../lib/http-error").HttpError} 版本缺失、非整数或超出安全范围时抛出 400。
 */
function normalizeAccessVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw badRequest("expectedAccessVersion 必须是正整数");
  return version;
}

/**
 * 规范化列表页查询，限制扫描量和单页大小以保护 Company 级资源。
 * @param {Record<string, unknown> | undefined} query URL 查询参数。
 * @returns {{page: number, pageSize: number, keyword: string, status: string}} 安全的列表查询条件。
 * @throws {import("../lib/http-error").HttpError} 页码、关键词或状态非法时抛出 400。
 */
function normalizeDocumentListQuery(query = {}) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw badRequest("文档页码格式无效");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > config.collab.maxListPageSize) {
    throw badRequest(`文档每页数量必须是 1 到 ${config.collab.maxListPageSize}`);
  }
  const keyword = query.keyword === undefined ? "" : String(query.keyword).trim();
  if (keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)) throw badRequest("文档检索词格式无效");
  const status = query.status === undefined || query.status === "" ? "active" : String(query.status);
  if (!DOCUMENT_STATUSES.has(status)) throw badRequest("文档状态无效");
  return { page, pageSize, keyword, status };
}

/**
 * 将用户资料转换为分享成员选择器 DTO，仅返回必要识别信息。
 * @param {Parse.User} user 当前 Company 内有效成员。
 * @returns {{userId: string, username: string, name: string, email: string}} 脱敏成员 DTO。
 */
function memberOptionDto(user) {
  return {
    userId: user.id,
    username: String(user.get("username") || ""),
    name: String(user.get("name") || user.get("nickname") || user.get("username") || "未命名成员"),
    email: String(user.get("email") || ""),
  };
}

/**
 * 查询当前用户可见的文档列表，并按文档组织范围逐条过滤，不把客户端筛选当作租户边界。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean, roleId?: string, role?: Parse.Object}} auth 可信认证上下文。
 * @param {Record<string, unknown>} query URL 查询参数。
 * @returns {Promise<{documents: Array<Record<string, unknown>>, count: number, page: number, pageSize: number}>} 分页文档 DTO。
 * @throws {import("../lib/http-error").HttpError} 页面权限、参数或数据库查询失败时抛出。
 */
async function listDocuments(auth, query) {
  const pagePermissions = await getCollabPagePermissions(auth);
  if (!pagePermissions.actions.has("query")) throw forbidden();
  const input = normalizeDocumentListQuery(query);
  const offset = (input.page - 1) * input.pageSize;
  const params = [auth.companyId, input.status];
  let where = "documents.company_id = $1 AND documents.status = $2";
  let memberSelect = "NULL::varchar AS viewer_member_role, false AS viewer_can_download";
  let memberJoin = "";
  if (!auth.isAdmin) {
    params.push(auth.userId);
    const userParam = params.length;
    memberSelect = "viewer_member.role AS viewer_member_role, viewer_member.can_download AS viewer_can_download";
    memberJoin = `
      LEFT JOIN collab.document_members viewer_member
        ON viewer_member.document_id = documents.id
       AND viewer_member.user_id = $${userParam}
       AND viewer_member.status = 'active'`;
    where += ` AND (documents.owner_user_id = $${userParam}
      OR viewer_member.user_id IS NOT NULL
      OR documents.access_mode = 'company_public')`;
    const organizations = await listTenantOrganizations(auth.companyId);
    const organizationIds = [...userDocumentOrganizationIds(organizations, auth.user)];
    params.push(organizationIds);
    where += ` AND (documents.organization_id IS NULL OR documents.organization_id = ANY($${params.length}::varchar[]))`;
    if (input.status === "deleted") where += ` AND documents.owner_user_id = $${userParam}`;
  }
  if (input.keyword) {
    params.push(`%${input.keyword.replace(/[%_\\]/g, "\\$&")}%`);
    where += ` AND documents.name ILIKE $${params.length} ESCAPE '\\'`;
  }
  const countResult = await queryCollab(
    `SELECT COUNT(*)::int AS count
       FROM collab.documents AS documents${memberJoin}
      WHERE ${where}`,
    params
  );
  const pageSizeParam = params.length + 1;
  const offsetParam = params.length + 2;
  params.push(input.pageSize, offset);
  const rowsResult = await queryCollab(
    `SELECT documents.id, documents.company_id, documents.organization_id, documents.owner_user_id,
            documents.name, documents.engine, documents.access_mode, documents.status,
            documents.access_version, documents.current_revision, documents.current_version_id,
            documents.source_object_key, documents.allow_download, documents.storage_limit_bytes, documents.created_by,
            documents.updated_by, documents.created_at, documents.updated_at, documents.deleted_at,
            current_version.size_bytes AS file_size_bytes,
            ${memberSelect}
       FROM collab.documents AS documents
       LEFT JOIN collab.document_versions AS current_version
         ON current_version.id = documents.current_version_id${memberJoin}
      WHERE ${where}
      ORDER BY documents.updated_at DESC, documents.id DESC
      LIMIT $${pageSizeParam} OFFSET $${offsetParam}`,
    params
  );

  const documents = [];
  const peopleById = await getDocumentPeopleMap(auth.companyId, rowsResult.rows);
  for (const document of rowsResult.rows) {
    const member = document.viewer_member_role
      ? { role: document.viewer_member_role, can_download: document.viewer_can_download === true }
      : null;
    const canRead = true;
    const role = auth.isAdmin ? "admin" : document.owner_user_id === auth.userId ? "owner" : member?.role || "viewer";
    const canEdit = pagePermissions.actions.has("edit") && document.status === "active" && (auth.isAdmin || document.owner_user_id === auth.userId || member?.role === "editor");
    const canComment = pagePermissions.actions.has("edit") && (auth.isAdmin || document.owner_user_id === auth.userId || ["editor", "commenter"].includes(member?.role));
    const canShare = pagePermissions.actions.has("share") && document.status !== "deleted" && (auth.isAdmin || document.owner_user_id === auth.userId);
    const canExport = pagePermissions.actions.has("export") && document.status === "active" && document.allow_download === true && (auth.isAdmin || document.owner_user_id === auth.userId || member?.can_download === true);
    const canHistory = pagePermissions.actions.has("history");
    documents.push(documentDto(document, { role, canRead, canEdit, canComment, canShare, canExport, canHistory }, peopleById));
  }
  return { documents, count: Number(countResult.rows[0]?.count || 0), page: input.page, pageSize: input.pageSize };
}

/**
 * 返回一份文档的 ACL 详情，供编辑器容器、分享面板和版本面板复用。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean, roleId?: string, role?: Parse.Object}} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @returns {Promise<Record<string, unknown>>} 文档安全 DTO 及当前用户权限。
 * @throws {import("../lib/http-error").HttpError} 页面权限、文档不存在或 ACL 不满足时抛出。
 */
async function getDocumentDetail(auth, documentId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  const access = await getDocumentAccess(auth, document, { pageAction: "query" });
  return documentDtoForAuth(auth, document, access);
}

/**
 * 查询文档成员权限；只有 owner 或系统管理员可以读取分享配置，避免 viewer 枚举成员资料。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean, roleId?: string, role?: Parse.Object}} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @returns {Promise<{documentId: string, accessVersion: number, accessMode: string, organizationId: string | null, allowDownload: boolean, storageLimitBytes: number | null, members: Array<Record<string, unknown>>}>} 成员权限列表、下载设置及当前文档容量上限。
 * @throws {import("../lib/http-error").HttpError} 文档不存在或无分享权限时抛出。
 */
async function listDocumentMembers(auth, documentId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  await getDocumentAccess(auth, document, { pageAction: "share", require: "share" });
  const result = await queryCollab(
    `SELECT document_id, user_id, role, status, can_download, granted_by, created_at, updated_at
       FROM collab.document_members
      WHERE document_id = $1::uuid
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'commenter' THEN 2 ELSE 3 END, user_id`,
    [document.id]
  );
  const users = await listActiveTenantUsers(auth.companyId, result.rows.map((row) => row.user_id));
  const usersById = new Map(users.map((user) => [user.id, memberOptionDto(user)]));
  return {
    documentId: document.id,
    accessVersion: Number(document.access_version),
    accessMode: document.access_mode,
    organizationId: document.organization_id || null,
    allowDownload: document.allow_download === true,
    storageLimitBytes: document.storage_limit_bytes === null || document.storage_limit_bytes === undefined
      ? null
      : Number(document.storage_limit_bytes),
    members: result.rows.map((row) => ({
      userId: row.user_id,
      role: row.role,
      status: row.status,
      canDownload: row.can_download === true,
      user: usersById.get(row.user_id) || { userId: row.user_id, username: "", name: "已离职成员", email: "" },
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
  };
}

/**
 * 查询可被当前文档 owner 选择的同 Company 有效成员，并按文档组织范围和操作者组织范围过滤。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean, roleId?: string, role?: Parse.Object}} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {Record<string, unknown>} query 可选 keyword 检索词。
 * @returns {Promise<Array<{userId: string, username: string, name: string, email: string}>>} 分享选择器成员数组。
 * @throws {import("../lib/http-error").HttpError} 无分享权限、参数错误或查询失败时抛出。
 */
async function listMemberOptions(auth, documentId, query = {}) {
  const document = await getTenantDocument(auth.companyId, documentId);
  await getDocumentAccess(auth, document, { pageAction: "share", require: "share" });
  const keyword = query.keyword === undefined ? "" : String(query.keyword).trim();
  if (keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)) throw badRequest("成员检索词格式无效");
  let parseQuery = new Parse.Query(Parse.User);
  if (keyword) {
    const nameQuery = new Parse.Query(Parse.User);
    nameQuery.contains("name", keyword);
    const usernameQuery = new Parse.Query(Parse.User);
    usernameQuery.contains("username", keyword);
    parseQuery = Parse.Query.or(nameQuery, usernameQuery);
  }
  parseQuery.equalTo("company", pointer("Company", auth.companyId));
  parseQuery.notEqualTo("isDelete", true);
  parseQuery.limit(MAX_MEMBER_OPTION_COUNT);
  const users = await parseQuery.find(master);
  const result = [];
  for (const user of users) {
    if (user.id === document.owner_user_id) continue;
    if (!(await isUserInOrganizationScope(user, document.organization_id, auth.companyId))) continue;
    if (!auth.isAdmin && !(await isUserWithinActorScope(auth.user, user, auth.companyId))) continue;
    result.push(memberOptionDto(user));
  }
  return result;
}

/**
 * 校验分享成员角色数组、目标成员租户和组织范围，并去重同一用户授权。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean}} auth 当前操作者认证上下文。
 * @param {Record<string, unknown>} document 文档数据库行。
 * @param {unknown} value 请求体中的 members 数组。
 * @returns {Promise<Array<{userId: string, role: "editor" | "commenter" | "viewer", canDownload: boolean, user: Parse.User}>>} 已验证成员。
 * @throws {import("../lib/http-error").HttpError} 角色重复、成员跨租户、停用或组织越界时抛出 400/403。
 */
async function validateMemberAssignments(auth, document, value) {
  if (!Array.isArray(value) || value.length > MAX_MEMBER_COUNT) {
    throw badRequest(`成员权限最多保存 ${MAX_MEMBER_COUNT} 人`);
  }
  const seen = new Set();
  const rawAssignments = value.map((item) => {
    if (!item || typeof item !== "object") throw badRequest("成员权限格式无效");
    const userId = normalizeObjectId(item.userId, "成员标识");
    if (userId === document.owner_user_id) throw badRequest("文档创建者不能作为普通成员重复授权");
    if (seen.has(userId)) throw badRequest("成员权限列表不能重复包含同一成员");
    seen.add(userId);
    if (!MEMBER_ROLES.has(item.role)) throw badRequest("成员角色只能是编辑、评论或查看");
    return { userId, role: item.role, canDownload: normalizeBoolean(item.canDownload, false) };
  });
  const users = await listActiveTenantUsers(auth.companyId, rawAssignments.map((item) => item.userId));
  const usersById = new Map(users.map((user) => [user.id, user]));
  if (usersById.size !== rawAssignments.length) throw collabError(400, "COLLAB_MEMBER_INVALID", "只能分享给当前企业内的有效成员");
  for (const assignment of rawAssignments) {
    const user = usersById.get(assignment.userId);
    if (!(await isUserInOrganizationScope(user, document.organization_id, auth.companyId))) {
      throw collabError(403, "COLLAB_MEMBER_OUT_OF_SCOPE", "不能分享给文档组织范围之外的成员");
    }
    if (!auth.isAdmin && !(await isUserWithinActorScope(auth.user, user, auth.companyId))) {
      throw collabError(403, "COLLAB_MEMBER_OUT_OF_SCOPE", "不能分享给当前操作者组织范围之外的成员");
    }
  }
  return rawAssignments.map((assignment) => ({ ...assignment, user: usersById.get(assignment.userId) }));
}

/**
 * 在事务中保存文档成员 ACL，并用 access_version 防止并发分享配置互相覆盖。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean, roleId?: string, role?: Parse.Object, sessionId?: string}} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {{expectedAccessVersion: unknown, members: unknown}} input 成员保存请求体。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID，用于审计关联。
 * @returns {Promise<{documentId: string, accessVersion: number, members: Array<Record<string, unknown>>}>} 更新后的成员权限。
 * @throws {import("../lib/http-error").HttpError} 版本冲突、权限不足或成员数据非法时抛出。
 */
async function saveDocumentMembers(auth, documentId, input, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  await getDocumentAccess(auth, document, { pageAction: "share", require: "share" });
  const expectedAccessVersion = normalizeAccessVersion(input?.expectedAccessVersion);
  const assignments = await validateMemberAssignments(auth, document, input?.members);
  await withCollabTransaction(async (client) => {
    const locked = await client.query(
      "SELECT id, access_version FROM collab.documents WHERE id = $1::uuid AND company_id = $2 FOR UPDATE",
      [document.id, auth.companyId]
    );
    const lockedDocument = locked.rows[0];
    if (!lockedDocument) throw collabError(404, "COLLAB_DOCUMENT_NOT_FOUND", "文档不存在或不属于当前企业");
    if (Number(lockedDocument.access_version) !== expectedAccessVersion) {
      throw collabError(409, "COLLAB_ACCESS_VERSION_CONFLICT", "分享配置已被其他请求修改，请刷新后重试");
    }
    for (const assignment of assignments) {
      await client.query(
        `INSERT INTO collab.document_members (document_id, user_id, role, status, can_download, granted_by, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, 'active', $4, $5, now(), now())
         ON CONFLICT (document_id, user_id)
         DO UPDATE SET role = EXCLUDED.role, status = 'active', can_download = EXCLUDED.can_download,
                       granted_by = EXCLUDED.granted_by, updated_at = now()`,
        [document.id, assignment.userId, assignment.role, assignment.canDownload, auth.userId]
      );
    }
    const retainedIds = [document.owner_user_id, ...assignments.map((assignment) => assignment.userId)];
    await client.query(
      `UPDATE collab.document_members
          SET status = 'revoked', updated_at = now()
        WHERE document_id = $1::uuid AND status = 'active' AND NOT (user_id = ANY($2::text[]))`,
      [document.id, retainedIds]
    );
    const updated = await client.query(
      `UPDATE collab.documents
          SET access_version = access_version + 1, updated_by = $3, updated_at = now()
        WHERE id = $1::uuid AND company_id = $2
        RETURNING access_version`,
      [document.id, auth.companyId, auth.userId]
    );
    await client.query(
      `INSERT INTO collab.document_audit_events (document_id, company_id, actor_user_id, action, request_id, metadata)
       VALUES ($1::uuid, $2, $3, 'members.updated', $4, $5::jsonb)`,
      [document.id, auth.companyId, auth.userId, requestId || null, JSON.stringify({ memberCount: assignments.length })]
    );
    return updated.rows[0];
  });
  return listDocumentMembers(auth, document.id);
}

/**
 * 切换文档指定成员/企业内公开访问模式，并递增 ACL 版本。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean, roleId?: string, role?: Parse.Object, sessionId?: string}} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {{accessMode: unknown, organizationId?: unknown, expectedAccessVersion: unknown}} input 访问设置请求体。
 * @param {string | undefined} requestId 当前请求 ID。
 * @returns {Promise<Record<string, unknown>>} 更新后的文档 DTO。
 * @throws {import("../lib/http-error").HttpError} 组织、版本或分享权限非法时抛出。
 */
async function updateDocumentAccess(auth, documentId, input, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  await getDocumentAccess(auth, document, { pageAction: "share", require: "share" });
  const accessMode = normalizeAccessMode(input?.accessMode);
  const organizationId = document.organization_id || null;
  if (input?.organizationId !== undefined) {
    const requestedOrganizationId = normalizeObjectId(input.organizationId, "组织标识", false);
    if (requestedOrganizationId !== organizationId) {
      throw collabError(400, "COLLAB_ORGANIZATION_IMMUTABLE", "文档组织范围创建后不可修改，请新建文档");
    }
  }
  const expectedAccessVersion = normalizeAccessVersion(input?.expectedAccessVersion);
  if (organizationId) {
    const organizationQuery = new Parse.Query("Organization");
    organizationQuery.equalTo("company", pointer("Company", auth.companyId));
    organizationQuery.equalTo("objectId", organizationId);
    organizationQuery.equalTo("isActive", true);
    if (!(await organizationQuery.first(master))) throw collabError(400, "COLLAB_ORGANIZATION_INVALID", "组织不存在或已停用");
  }
  if (!auth.isAdmin && organizationId && !(await isUserInOrganizationScope(auth.user, organizationId, auth.companyId))) {
    throw collabError(403, "COLLAB_ORGANIZATION_OUT_OF_SCOPE", "不能把文档范围设置到当前操作者无权管理的组织");
  }
  const updated = await withCollabTransaction(async (client) => {
    const result = await client.query(
      `UPDATE collab.documents
           SET access_mode = $4, access_version = access_version + 1,
               updated_by = $3, updated_at = now()
         WHERE id = $1::uuid AND company_id = $2 AND access_version = $5
         RETURNING id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
                   access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
                   created_by, updated_by, created_at, updated_at, deleted_at`,
      [document.id, auth.companyId, auth.userId, accessMode, expectedAccessVersion]
    );
    if (!result.rowCount) throw collabError(409, "COLLAB_ACCESS_VERSION_CONFLICT", "分享配置已被其他请求修改，请刷新后重试");
    await client.query(
      `INSERT INTO collab.document_audit_events (document_id, company_id, actor_user_id, action, request_id, metadata)
       VALUES ($1::uuid, $2, $3, 'access.updated', $4, $5::jsonb)`,
      [document.id, auth.companyId, auth.userId, requestId || null, JSON.stringify({ accessMode, organizationId })]
    );
    return result.rows[0];
  });
  const access = await getDocumentAccess(auth, updated, { pageAction: "query" });
  return documentDtoForAuth(auth, updated, access);
}

/**
 * 将文档所有权转移给当前 Company 内、文档组织范围内的有效成员，并保留原所有者的编辑权限。
 * 转移使用 access_version 乐观锁，避免并发分享或转移覆盖最新 ACL；所有权变更写入审计日志。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean, roleId?: string, role?: Parse.Object}} auth 可信认证上下文。
 * @param {unknown} documentId URL 中的文档 UUID。
 * @param {{newOwnerUserId?: unknown, expectedAccessVersion?: unknown}} input 转移目标成员 objectId 和当前 accessVersion。
 * @param {string | undefined} requestId 当前 HTTP 请求 ID。
 * @returns {Promise<Record<string, unknown>>} 转移后的文档安全 DTO，包含新的 ownerUserId/ownerName。
 * @throws {import("../lib/http-error").HttpError} 分享权限不足、目标成员无效/越界、版本冲突或文档状态异常时抛出。
 */
async function transferDocumentOwnership(auth, documentId, input = {}, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  await getDocumentAccess(auth, document, { pageAction: "share", require: "share" });
  const newOwnerUserId = normalizeObjectId(input?.newOwnerUserId, "新所有者");
  if (newOwnerUserId === document.owner_user_id) {
    throw collabError(400, "COLLAB_OWNER_INVALID", "新所有者必须是其他成员");
  }
  const expectedAccessVersion = normalizeAccessVersion(input?.expectedAccessVersion);
  const targetUser = await findActiveTenantUser(auth.companyId, newOwnerUserId);
  if (!targetUser) throw collabError(400, "COLLAB_OWNER_INVALID", "新所有者必须是当前企业内的有效成员");
  if (!(await isUserInOrganizationScope(targetUser, document.organization_id, auth.companyId))) {
    throw collabError(403, "COLLAB_OWNER_OUT_OF_SCOPE", "新所有者不在文档组织范围内");
  }
  if (!auth.isAdmin && !(await isUserWithinActorScope(auth.user, targetUser, auth.companyId))) {
    throw collabError(403, "COLLAB_OWNER_OUT_OF_SCOPE", "不能把所有权转移给当前操作者组织范围之外的成员");
  }

  const transferred = await withCollabTransaction(async (client) => {
    const lockedResult = await client.query(
      `SELECT id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
              access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
              created_by, updated_by, created_at, updated_at, deleted_at
         FROM collab.documents
        WHERE id = $1::uuid AND company_id = $2
        FOR UPDATE`,
      [document.id, auth.companyId]
    );
    const lockedDocument = lockedResult.rows[0];
    if (!lockedDocument || lockedDocument.status === "deleted") {
      throw collabError(404, "COLLAB_DOCUMENT_NOT_FOUND", "文档不存在或已删除");
    }
    if (Number(lockedDocument.access_version) !== expectedAccessVersion) {
      throw collabError(409, "COLLAB_ACCESS_VERSION_CONFLICT", "所有权配置已被其他请求修改，请刷新后重试");
    }
    if (lockedDocument.owner_user_id === newOwnerUserId) {
      throw collabError(409, "COLLAB_ACCESS_VERSION_CONFLICT", "所有权已被其他请求修改，请刷新后重试");
    }

    const ownerAndTarget = await client.query(
      `SELECT user_id, can_download
         FROM collab.document_members
        WHERE document_id = $1::uuid AND user_id = ANY($2::text[])
        FOR UPDATE`,
      [document.id, [lockedDocument.owner_user_id, newOwnerUserId]]
    );
    const targetMember = ownerAndTarget.rows.find((row) => row.user_id === newOwnerUserId);
    const targetCanDownload = targetMember ? targetMember.can_download === true : lockedDocument.allow_download === true;

    // 原所有者降为编辑者并保留 active 记录，避免转移后突然失去正在编辑的权限。
    await client.query(
      `INSERT INTO collab.document_members
        (document_id, user_id, role, status, can_download, granted_by, created_at, updated_at)
       VALUES ($1::uuid, $2, 'editor', 'active', $3, $4, now(), now())
       ON CONFLICT (document_id, user_id)
       DO UPDATE SET role = 'editor', status = 'active', updated_at = now()`,
      [document.id, lockedDocument.owner_user_id, lockedDocument.allow_download === true, auth.userId]
    );
    await client.query(
      `INSERT INTO collab.document_members
        (document_id, user_id, role, status, can_download, granted_by, created_at, updated_at)
       VALUES ($1::uuid, $2, 'owner', 'active', $3, $4, now(), now())
       ON CONFLICT (document_id, user_id)
       DO UPDATE SET role = 'owner', status = 'active', can_download = EXCLUDED.can_download,
                     granted_by = EXCLUDED.granted_by, updated_at = now()`,
      [document.id, newOwnerUserId, targetCanDownload, auth.userId]
    );
    const updated = await client.query(
      `UPDATE collab.documents
          SET owner_user_id = $3, access_version = access_version + 1,
              updated_by = $4, updated_at = now()
        WHERE id = $1::uuid AND company_id = $2 AND access_version = $5 AND status <> 'deleted'
        RETURNING id, company_id, organization_id, owner_user_id, name, engine, access_mode, status,
                  access_version, current_revision, current_version_id, source_object_key, allow_download, storage_limit_bytes,
                  created_by, updated_by, created_at, updated_at, deleted_at`,
      [document.id, auth.companyId, newOwnerUserId, auth.userId, expectedAccessVersion]
    );
    if (!updated.rowCount) throw collabError(409, "COLLAB_ACCESS_VERSION_CONFLICT", "所有权配置已被其他请求修改，请刷新后重试");
    await client.query(
      `INSERT INTO collab.document_audit_events (document_id, company_id, actor_user_id, action, request_id, metadata)
       VALUES ($1::uuid, $2, $3, 'owner.transferred', $4, $5::jsonb)`,
      [
        document.id,
        auth.companyId,
        auth.userId,
        requestId || null,
        JSON.stringify({ previousOwnerUserId: lockedDocument.owner_user_id, newOwnerUserId }),
      ]
    );
    return updated.rows[0];
  });

  const access = await getDocumentAccess(auth, transferred, { pageAction: "query" });
  return documentDtoForAuth(auth, transferred, access);
}

/**
 * 撤销一名文档成员的访问权；owner 记录永远不能被删除或降级。
 * @param {{companyId: string, userId: string, user?: Parse.User, isAdmin?: boolean, roleId?: string, role?: Parse.Object}} auth 可信认证上下文。
 * @param {unknown} documentId 文档 UUID。
 * @param {unknown} memberUserId 待移除成员 objectId。
 * @param {string | undefined} requestId 当前请求 ID。
 * @returns {Promise<{documentId: string, userId: string, accessVersion: number}>} 撤销结果。
 * @throws {import("../lib/http-error").HttpError} owner、成员不存在、版本或分享权限错误时抛出。
 */
async function removeDocumentMember(auth, documentId, memberUserId, requestId) {
  const document = await getTenantDocument(auth.companyId, documentId);
  await getDocumentAccess(auth, document, { pageAction: "share", require: "share" });
  const normalizedUserId = normalizeObjectId(memberUserId, "成员标识");
  if (normalizedUserId === document.owner_user_id) throw collabError(400, "COLLAB_OWNER_REQUIRED", "文档创建者不能被移除");
  const result = await withCollabTransaction(async (client) => {
    const member = await client.query(
      "SELECT role FROM collab.document_members WHERE document_id = $1::uuid AND user_id = $2 AND status = 'active' FOR UPDATE",
      [document.id, normalizedUserId]
    );
    if (!member.rowCount) throw collabError(404, "COLLAB_MEMBER_NOT_FOUND", "文档成员不存在");
    if (member.rows[0].role === "owner") throw collabError(400, "COLLAB_OWNER_REQUIRED", "文档必须保留一个创建者");
    await client.query(
      "UPDATE collab.document_members SET status = 'revoked', updated_at = now() WHERE document_id = $1::uuid AND user_id = $2",
      [document.id, normalizedUserId]
    );
    const updated = await client.query(
      "UPDATE collab.documents SET access_version = access_version + 1, updated_by = $3, updated_at = now() WHERE id = $1::uuid AND company_id = $2 RETURNING access_version",
      [document.id, auth.companyId, auth.userId]
    );
    await client.query(
      `INSERT INTO collab.document_audit_events (document_id, company_id, actor_user_id, action, request_id, metadata)
       VALUES ($1::uuid, $2, $3, 'member.revoked', $4, $5::jsonb)`,
      [document.id, auth.companyId, auth.userId, requestId || null, JSON.stringify({ userId: normalizedUserId })]
    );
    return updated.rows[0];
  });
  return { documentId: document.id, userId: normalizedUserId, accessVersion: Number(result.access_version) };
}

module.exports = {
  COLLAB_PAGE_SYSTEM_KEY,
  PAGE_ACTIONS,
  DOCUMENT_ROLES,
  MEMBER_ROLES,
  ACCESS_MODES,
  DOCUMENT_STATUSES,
  collabError,
  normalizeObjectId,
  normalizeDocumentId,
  normalizeAccessMode,
  normalizeDocumentName,
  normalizeBoolean,
  normalizeAccessVersion,
  normalizeDocumentListQuery,
  pointerId,
  userOrganizationIds,
  listTenantOrganizations,
  expandOrganizationIds,
  isUserInOrganizationScope,
  isUserWithinActorScope,
  listActiveTenantUsers,
  findActiveTenantUser,
  getCollabPagePermissions,
  assertCollabPagePermission,
  getTenantDocument,
  getDocumentAccess,
  documentDto,
  documentDtoForAuth,
  getDocumentPeopleMap,
  listDocuments,
  getDocumentDetail,
  listDocumentMembers,
  listMemberOptions,
  saveDocumentMembers,
  updateDocumentAccess,
  transferDocumentOwnership,
  removeDocumentMember,
};
