"use strict";

const Parse = require("parse/node");
const { badRequest, forbidden, notFound, unauthorized } = require("../lib/http-error");
const { config } = require("../config/env");
const { initializeParse } = require("./parse-runtime");
const { ensureOrganizationInfrastructure } = require("./organization.service");

initializeParse();

/** 仅由 BFF 使用的管理端会话 Schema；sessionId 永远不会返回给浏览器。 */
const ADMIN_SESSION_CLASS = "AdminSession";
/** Master Key 只在服务端会话登记、续期和撤销流程中使用。 */
const master = { useMasterKey: true };
/** 在线会话列表的硬上限，避免管理员页面读取无界的历史会话。 */
const MAX_ONLINE_SESSIONS = 10_000;
/** 冻结账号允许的最长时间，单位为分钟，最多 30 天。 */
const MAX_FREEZE_MINUTES = 30 * 24 * 60;
let schemaReadyPromise = null;

/**
 * 将可信认证上下文中的对象转换为 Parse Pointer JSON。
 * @param {string} className Pointer 目标 Parse 类名。
 * @param {string} objectId Pointer 目标 objectId。
 * @returns {{__type: "Pointer", className: string, objectId: string}} 可保存到 Parse 的指针。
 */
function pointer(className, objectId) {
  return { __type: "Pointer", className, objectId };
}

/**
 * 从 Parse Object 或序列化 Pointer 中提取 objectId。
 * @param {unknown} value 可能是 Parse Object、Pointer JSON 或空值。
 * @returns {string | null} 提取到的 objectId；无法提取时返回 null。
 */
function pointerId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || value.objectId || null;
}

/**
 * 确保管理端会话 Schema 在旧部署中具备所需字段；已有字段不会被覆盖或删除。
 * @returns {Promise<void>} Schema 可读写时兑现；Parse 配置或网络失败时抛出异常。
 */
async function ensureAdminSessionInfrastructure() {
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    const fields = [
      { name: "company", type: "Pointer", options: { targetClass: "Company" } },
      { name: "user", type: "Pointer", options: { targetClass: "_User" } },
      { name: "sessionId", type: "String" },
      { name: "deviceInfo", type: "String" },
      { name: "lastSeenAt", type: "Date" },
      { name: "expiresAt", type: "Date" },
      { name: "revokedAt", type: "Date" },
      { name: "revokedReason", type: "String" },
    ];
    const schemas = await Parse.Schema.all(master);
    const definition = schemas.find((schema) => schema.className === ADMIN_SESSION_CLASS);
    const missingFields = fields.filter((field) => !definition?.fields?.[field.name]);
    if (!definition) {
      const schema = new Parse.Schema(ADMIN_SESSION_CLASS);
      fields.forEach((field) => schema.addField(field.name, field.type, field.options || {}));
      schema.setCLP(new Parse.CLP());
      await schema.save(master);
      return;
    }
    if (missingFields.length) {
      const schema = new Parse.Schema(ADMIN_SESSION_CLASS);
      missingFields.forEach((field) => schema.addField(field.name, field.type, field.options || {}));
      await schema.update(master);
    }
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });

  return schemaReadyPromise;
}

/**
 * 将 User-Agent 压缩为管理员可读的设备描述，不保存完整请求头或 IP 等不必要信息。
 * @param {string | undefined} userAgent 浏览器 User-Agent 文本。
 * @returns {string} 例如“桌面端 · Windows · Chrome”；解析失败时返回“未知设备”。
 */
function describeDevice(userAgent) {
  const value = typeof userAgent === "string" ? userAgent : "";
  const type = /mobile|android|iphone|ipad/i.test(value) ? "移动端" : "桌面端";
  const operatingSystem = /Windows/i.test(value)
    ? "Windows"
    : /Mac OS X/i.test(value)
      ? "macOS"
      : /Android/i.test(value)
        ? "Android"
        : /iPhone|iPad/i.test(value)
          ? "iOS"
          : /Linux/i.test(value)
            ? "Linux"
            : "未知系统";
  const browser = /Edg\//i.test(value)
    ? "Edge"
    : /Chrome\//i.test(value)
      ? "Chrome"
      : /Firefox\//i.test(value)
        ? "Firefox"
        : /Safari\//i.test(value)
          ? "Safari"
          : "未知浏览器";
  return `${type} · ${operatingSystem} · ${browser}`;
}

/**
 * 返回请求的安全设备描述；不把完整 User-Agent 写入日志或响应。
 * @param {import("express").Request | undefined} req Express 请求对象，可为空。
 * @returns {string} 受长度限制的设备描述。
 */
function requestDeviceInfo(req) {
  return describeDevice(req?.get?.("user-agent"));
}

/**
 * 计算当前会话的滑动过期时间。
 * @param {Date} now 计算基准时间。
 * @returns {Date} 当前时间加上服务端会话 TTL 后的时间。
 */
function sessionExpiry(now) {
  return new Date(now.getTime() + config.auth.ttlSeconds * 1_000);
}

/**
 * 将在线会话记录转换为管理页面的脱敏 DTO；不返回 JWT、CSRF 或内部 sessionId。
 * @param {Parse.Object} record AdminSession 记录，必须已 include user。
 * @returns {Record<string, unknown> | null} 在线会话 DTO；用户记录缺失时返回 null。
 */
function onlineSessionDto(record) {
  const user = record.get("user");
  const userId = pointerId(user);
  if (!userId) return null;
  const createdAt = record.createdAt?.toISOString?.() || null;
  const lastSeenAt = record.get("lastSeenAt")?.toISOString?.() || createdAt;
  return {
    objectId: record.id,
    userId,
    username: user.get?.("username") || "",
    name: user.get?.("name") || user.get?.("nickname") || user.get?.("username") || "未命名成员",
    phone: user.get?.("phone") || user.get?.("mobilePhone") || "",
    onlineAt: createdAt,
    lastSeenAt,
    deviceInfo: record.get("deviceInfo") || "未知设备",
  };
}

/**
 * 在用户登录成功后登记一个可撤销的管理端会话。
 * @param {{companyId: string, userId: string}} auth 当前登录成功后由服务端生成的认证上下文。
 * @param {{sessionId: string}} session createSession 生成的会话声明；sessionId 只用于服务端匹配 JWT jti。
 * @param {import("express").Request | undefined} req 登录请求，用于提取设备类型。
 * @returns {Promise<void>} 会话记录保存成功后兑现；失败时由登录调用方决定是否降级。
 */
async function registerAdminSession(auth, session, req) {
  await ensureAdminSessionInfrastructure();
  const now = new Date();
  const AdminSession = Parse.Object.extend(ADMIN_SESSION_CLASS);
  const record = new AdminSession();
  record.set("company", pointer("Company", auth.companyId));
  record.set("user", pointer("_User", auth.userId));
  record.set("sessionId", session.sessionId);
  record.set("deviceInfo", requestDeviceInfo(req));
  record.set("lastSeenAt", now);
  record.set("expiresAt", sessionExpiry(now));
  await record.save(null, master);
}

/**
 * 校验 JWT 对应的会话是否仍有效，并刷新在线心跳和滑动过期时间；旧部署未登记的会话会自动补登记。
 * @param {{jti?: string, sub?: string}} session 已通过 JWT 签名、issuer 和 audience 校验的声明。
 * @param {{companyId: string, userId: string}} auth 已通过账号与租户校验的认证上下文。
 * @param {import("express").Request | undefined} req 当前请求，用于补登记旧会话的设备类型。
 * @returns {Promise<void>} 会话有效且心跳保存完成后兑现。
 * @throws {import("../lib/http-error").HttpError} 会话被强制撤销、已过期或声明与用户不匹配时抛出 401。
 */
async function validateAndTouchAdminSession(session, auth, req) {
  if (typeof session?.jti !== "string" || session.jti.length > 128) throw unauthorized("Your session is invalid");
  await ensureAdminSessionInfrastructure();
  const query = new Parse.Query(ADMIN_SESSION_CLASS);
  query.equalTo("sessionId", session.jti);
  query.equalTo("user", pointer("_User", auth.userId));
  const record = await query.first(master);
  if (!record) {
    await registerAdminSession(auth, { sessionId: session.jti }, req);
    return;
  }

  const expiresAt = record.get("expiresAt");
  if (record.get("revokedAt") || (expiresAt instanceof Date && expiresAt.getTime() <= Date.now())) {
    throw unauthorized("Your session has been revoked");
  }
  const now = new Date();
  record.set("lastSeenAt", now);
  record.set("expiresAt", sessionExpiry(now));
  await record.save(null, master);
}

/**
 * 规范化在线成员操作目标，确保目标用户属于当前企业且不是被伪造的跨租户用户。
 * @param {{companyId: string, isAdmin?: boolean}} auth 当前管理员认证上下文。
 * @param {unknown} userId URL 中的目标成员 objectId。
 * @returns {Promise<Parse.Object>} 当前企业内的目标用户。
 * @throws {import("../lib/http-error").HttpError} 非管理员、标识无效或用户不属于当前企业时抛出 400/403/404。
 */
async function getTenantUser(auth, userId) {
  if (!auth?.isAdmin) throw forbidden("仅系统管理员可以管理在线成员");
  if (typeof userId !== "string" || !userId.trim() || userId.trim().length > 128) {
    throw badRequest("成员标识格式无效");
  }
  const query = new Parse.Query(Parse.User);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.equalTo("objectId", userId.trim());
  const user = await query.first(master);
  if (!user) throw notFound("成员不存在或不属于当前企业");
  return user;
}

/**
 * 查询当前企业仍有有效 JWT 的在线会话，并返回按最近心跳排序的成员设备列表。
 * @param {{companyId: string, isAdmin?: boolean}} auth 当前管理员认证上下文。
 * @returns {Promise<{sessions: Array<Record<string, unknown>>, count: number}>} 在线会话脱敏列表与数量。
 * @throws {import("../lib/http-error").HttpError} 非管理员或会话 Schema 查询失败时抛出。
 */
async function listOnlineMemberSessions(auth) {
  if (!auth?.isAdmin) throw forbidden("仅系统管理员可以查看在线成员");
  await ensureAdminSessionInfrastructure();
  const query = new Parse.Query(ADMIN_SESSION_CLASS);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.doesNotExist("revokedAt");
  query.greaterThan("expiresAt", new Date());
  query.include("user");
  query.descending("lastSeenAt");
  query.limit(MAX_ONLINE_SESSIONS);
  const records = await query.find(master);
  const sessions = records.map(onlineSessionDto).filter(Boolean);
  return { sessions, count: sessions.length };
}

/**
 * 撤销当前企业目标成员的全部在线会话，使其现有 JWT 在下一次请求时立即失效。
 * @param {{companyId: string, isAdmin?: boolean}} auth 当前管理员认证上下文。
 * @param {unknown} userId 目标成员 objectId。
 * @returns {Promise<{userId: string, revokedCount: number}>} 被撤销的会话数量。
 * @throws {import("../lib/http-error").HttpError} 目标成员不存在、权限不足或数据写入失败时抛出。
 */
async function forceLogoutOnlineMember(auth, userId) {
  const user = await getTenantUser(auth, userId);
  await ensureAdminSessionInfrastructure();
  const query = new Parse.Query(ADMIN_SESSION_CLASS);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.equalTo("user", pointer("_User", user.id));
  query.doesNotExist("revokedAt");
  query.limit(MAX_ONLINE_SESSIONS);
  const records = await query.find(master);
  const revokedAt = new Date();
  await Promise.all(
    records.map((record) => {
      record.set("revokedAt", revokedAt);
      record.set("revokedReason", "管理员强制下线");
      return record.save(null, master);
    })
  );
  return { userId: user.id, revokedCount: records.length };
}

/**
 * 校验冻结时长并冻结目标账号，同时撤销其当前全部在线会话。
 * @param {{companyId: string, isAdmin?: boolean}} auth 当前管理员认证上下文。
 * @param {unknown} userId 目标成员 objectId。
 * @param {unknown} durationMinutes 冻结时长，单位为分钟，范围 1 至 43200。
 * @returns {Promise<{userId: string, frozenUntil: string}>} 冻结截止时间和目标用户标识。
 * @throws {import("../lib/http-error").HttpError} 时长无效、目标不存在或写入失败时抛出 400/403/404。
 */
async function freezeOnlineMember(auth, userId, durationMinutes) {
  const user = await getTenantUser(auth, userId);
  await ensureOrganizationInfrastructure();
  const minutes = Number(durationMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_FREEZE_MINUTES) {
    throw badRequest(`冻结时长必须是 1 到 ${MAX_FREEZE_MINUTES} 分钟之间的整数`);
  }
  const frozenUntil = new Date(Date.now() + minutes * 60_000);
  user.set("frozenUntil", frozenUntil);
  await user.save(null, master);
  await forceLogoutOnlineMember(auth, user.id);
  return { userId: user.id, frozenUntil: frozenUntil.toISOString() };
}

module.exports = {
  ADMIN_SESSION_CLASS,
  ensureAdminSessionInfrastructure,
  registerAdminSession,
  validateAndTouchAdminSession,
  listOnlineMemberSessions,
  forceLogoutOnlineMember,
  freezeOnlineMember,
};
