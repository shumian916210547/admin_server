"use strict";

const { badRequest, forbidden, notFound } = require("../lib/http-error");
const { authorizeAction } = require("./parse-data.service");
const db = require("./camera-db.service");

/** 四个独立页面的权限目标；媒体读取允许设备页或视频中心，写设备仍只检查设备页。 */
const targets = ["CameraOrganization", "CameraDevice", "CameraMember", "CameraVideo"];

/**
 * 验证视频领域 UUID，拒绝任意路径和数据库类型转换错误。
 * @param {unknown} value 必填，UUID v4 字符串。
 * @returns {string} 小写 UUID，无副作用。
 * @throws {HttpError} 标识格式不合法时 400。
 */
function id(value) {
  if (typeof value !== "string" || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)) throw badRequest("视频业务标识格式无效");
  return value.toLowerCase();
}

/**
 * 校验领域表单文本，禁止控制字符，避免把不可信内容用于协议或日志。
 * @param {unknown} value 必填，待校验文本；空值按空字符串处理。
 * @param {string} label 必填，中文字段名。
 * @param {number} max 必填，最大字符长度。
 * @param {boolean} [required=false] 可选，是否必须非空。
 * @returns {string} 去除首尾空白后的安全文本。
 * @throws {HttpError} 文本格式不合法时 400。
 */
function text(value, label, max, required = false) {
  const result = value ?? "";
  if (typeof result !== "string" || result.length > max || /[\x00-\x1f\x7f]/.test(result) || (required && !result.trim())) throw badRequest(`${label}格式无效，最多 ${max} 个字符`);
  return result.trim();
}

/**
 * 复用平台真实岗位与逐页面按钮授权，不能用摄像头组织归属替代页面授权。
 * @param {object} auth 必填，authenticate 注入的可信会话。
 * @param {string} target 必填，targets 中定义的权限目标。
 * @param {string} [action="query"] 可选，query/insert/edit/remove。
 * @returns {Promise<void>} 授权通过；无写入。
 * @throws {HttpError} 会话、目标或按钮权限无效时 403。
 */
async function authorize(auth, target, action = "query") {
  if (!auth?.companyId || !targets.includes(target)) throw forbidden("视频模块会话或权限目标无效");
  await authorizeAction(auth, target, action);
}

/**
 * 为共用资源校验任一页面的查询权限，只忽略明确的 403，其他错误原样抛出。
 * @param {object} auth 必填，可信会话。
 * @param {string[]} [allowed=targets] 可选，可用于读取资源的固定页面目标列表。
 * @returns {Promise<void>} 任一页面已授权时兑现。
 * @throws {HttpError|Error} 所有页面均无权限时 403；数据源错误继续失败。
 */
async function authorizeRead(auth, allowed = targets) {
  for (const target of allowed) {
    try { await authorize(auth, target); return; }
    catch (error) { if (error.status !== 403) throw error; }
  }
  throw forbidden("没有摄像头模块的页面查询权限");
}

/**
 * 将组织按父子关系组装为树；被权限裁剪的父节点缺失时将可见节点提升为本次树根。
 * @param {object[]} rows 必填，同租户且已授权的组织 DTO 数组。
 * @returns {object[]} 新建树结构，不修改输入记录。
 */
function tree(rows) {
  const nodes = new Map(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    if (nodes.has(node.parent_id)) nodes.get(node.parent_id).children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * 解析当前成员的摄像头组织范围；平台管理员可维护所有节点，普通账号无有效成员关系则默认无访问。
 * 已停用组织及其后代不进入普通成员范围；每次媒体请求重新计算，授权变更立即生效。
 * @param {object} auth 必填，可信 companyId/userId/isAdmin。
 * @returns {Promise<{rows:object[],ids:string[]|null}>} 企业组织记录、可访问组织 ID；null 仅代表平台管理员不限范围。
 * @throws {HttpError} 数据库不可用时 503，不降级为全企业访问。
 */
async function scope(auth) {
  const rows = (await db.query("SELECT * FROM camera.organizations WHERE company_id=$1 ORDER BY rank,name,id LIMIT 5001", [auth.companyId])).rows;
  if (rows.length > 5000) throw badRequest("视频组织节点超过 5000，请联系管理员整理");
  if (auth.isAdmin) return { rows, ids: null };
  const membership = (await db.query("SELECT * FROM camera.members WHERE company_id=$1 AND user_id=$2 AND is_active=true", [auth.companyId, auth.userId])).rows[0];
  if (!membership) return { rows, ids: [] };
  const byId = new Map(rows.map((row) => [row.id, row]));
  let parent = byId.get(membership.organization_id);
  const visited = new Set();
  while (parent) {
    if (!parent.is_active || visited.has(parent.id)) return { rows, ids: [] };
    visited.add(parent.id);
    parent = byId.get(parent.parent_id);
  }
  if (!byId.has(membership.organization_id)) return { rows, ids: [] };
  const ids = [membership.organization_id];
  if (membership.include_descendants) {
    const children = new Map();
    for (const row of rows) { if (!children.has(row.parent_id)) children.set(row.parent_id, []); if (row.is_active) children.get(row.parent_id).push(row.id); }
    const included = new Set(ids);
    for (let index = 0; index < ids.length; index += 1) {
      for (const child of children.get(ids[index]) || []) if (!included.has(child)) { included.add(child); ids.push(child); }
    }
  }
  return { rows, ids };
}

/**
 * 验证组织同租户、有效并位于当前成员授权范围；仅平台管理员可查看未归属设备。
 * @param {object} auth 必填，可信会话。
 * @param {string|null} organizationId 必填，设备/成员归属组织；null 为历史未分配设备。
 * @param {boolean} [requireActive=false] 可选，新归属必须处于启用组织时设为 true。
 * @returns {Promise<object|null>} 组织记录或管理员可见的未分配标记。
 * @throws {HttpError} 跨租户、范围外、停用或无效组织返回 404/400。
 */
async function organization(auth, organizationId, requireActive = false) {
  if (!organizationId) {
    if (auth.isAdmin && !requireActive) return null;
    throw notFound("设备或组织不在当前视频授权范围内");
  }
  id(organizationId);
  const context = await scope(auth);
  const row = context.rows.find((item) => item.id === organizationId);
  if (!row || (context.ids && !context.ids.includes(organizationId))) throw notFound("组织不存在或不在当前视频授权范围内");
  if (requireActive && !row.is_active) throw badRequest("不能将设备或成员分配到停用组织");
  return row;
}

/**
 * 计算页面按钮授权用于前端体验，后端写接口仍需再次校验。
 * @param {object} auth 必填，可信会话。
 * @param {string} target 必填，固定页面权限目标。
 * @returns {Promise<object>} query/insert/edit/remove 布尔映射。
 * @throws {Error} 非权限类数据源异常继续抛出。
 */
async function permissions(auth, target) {
  const result = {};
  for (const action of ["query", "insert", "edit", "remove"]) {
    try { await authorize(auth, target, action); result[action] = true; }
    catch (error) { if (error.status !== 403) throw error; result[action] = false; }
  }
  return result;
}

module.exports = { id, text, authorize, authorizeRead, scope, organization, permissions, tree };
