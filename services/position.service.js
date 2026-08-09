"use strict";

const Parse = require("parse/node");
const { badRequest, forbidden, notFound } = require("../lib/http-error");
const { initializeParse } = require("./parse-runtime");

initializeParse();

/** 仅供 BFF 内部维护岗位、页面和按钮授权时使用的 Master Key 选项。 */
const master = { useMasterKey: true };
/** 岗位在现有 RBAC 模型中的实际 Parse 类名；前端统一以“岗位”呈现。 */
const ROLE_CLASS = "Role";
/** 可配置页面在现有元数据模型中的 Parse 类名。 */
const ROUTE_CLASS = "Route";
/** 页面分组在现有元数据模型中的 Parse 类名。 */
const MODULE_CLASS = "Module";
/** 岗位与页面按钮的授权记录在现有 RBAC 模型中的 Parse 类名。 */
const ALLOT_PERMISSION_CLASS = "AllotPermission";
/** 单个岗位允许配置的最大页面数，防止恶意请求写入无界授权对象。 */
const MAX_POSITION_PAGES = 200;
/** 单个岗位配置接口允许读取的最大同租户记录数。 */
const MAX_CONFIGURATION_RECORDS = 10_000;
/** Parse 查询的单批记录数量；用于加载中大型企业的系统配置。 */
const QUERY_BATCH_SIZE = 1_000;
/** 可在页面内分配的标准按钮权限；必须与 parse-data.service 的服务端校验保持一致。 */
const BUTTON_PERMISSION_CODES = Object.freeze([
  "permission:query",
  "permission:reset",
  "permission:insert",
  "permission:preview",
  "permission:insertChildren",
  "permission:edit",
  "permission:remove",
  "permission:insertField",
  "permission:editField",
  "permission:removeField",
]);
const BUTTON_PERMISSION_SET = new Set(BUTTON_PERMISSION_CODES);

/**
 * 将可信类名与对象标识转换为 Parse Pointer JSON。
 * @param {string} className Parse 类名。
 * @param {string} objectId 已通过服务端验证的对象标识。
 * @returns {{__type: "Pointer", className: string, objectId: string}} 可安全保存或查询的 Pointer。
 */
function pointer(className, objectId) {
  return { __type: "Pointer", className, objectId };
}

/**
 * 从 Parse Object、Pointer JSON 或兼容序列化对象中读取 objectId。
 * @param {unknown} value 任意关联字段的值。
 * @returns {string | null} 可用 objectId；值不存在或格式不支持时返回 null。
 */
function pointerId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || value.objectId || null;
}

/**
 * 判断值是否为可安全读取键的普通记录对象。
 * @param {unknown} value 待检查的值。
 * @returns {boolean} 仅当值为非空、非数组对象时返回 true。
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 限制岗位配置入口只能由当前 Company 的系统管理员使用，避免普通岗位自行扩大菜单或按钮权限。
 * @param {{isAdmin?: boolean}} auth authenticate 中间件提供的可信认证上下文。
 * @returns {void} 系统管理员时正常返回。
 * @throws {import("../lib/http-error").HttpError} 非系统管理员时抛出 403。
 */
function assertSystemAdministrator(auth) {
  if (!auth?.isAdmin) throw forbidden("仅系统管理员可以维护岗位权限");
}

/**
 * 规范化 URL 或请求体中的 Parse objectId，拒绝空值、非字符串和异常长值。
 * @param {unknown} value 原始对象标识。
 * @param {string} label 错误信息中使用的中文字段名称。
 * @param {boolean} [required=true] 是否要求必须提供该值。
 * @returns {string | null} 去除首尾空白后的合法 objectId；非必填的空值返回 null。
 * @throws {import("../lib/http-error").HttpError} 值格式无效时抛出 400。
 */
function normalizeObjectId(value, label, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) throw badRequest(`${label}不能为空`);
    return null;
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128) {
    throw badRequest(`${label}格式无效`);
  }
  return value.trim();
}

/**
 * 验证并规范化岗位名称，避免岗位名为空、超长或仅由空白组成。
 * @param {unknown} value 岗位表单中的名称。
 * @returns {string} 去除首尾空白后的岗位名称。
 * @throws {import("../lib/http-error").HttpError} 名称无效时抛出 400。
 */
function normalizePositionName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    throw badRequest("岗位名称不能为空且长度不能超过 100 个字符");
  }
  return value.trim();
}

/**
 * 为已有或新部署的 Parse Schema 补齐岗位配置需要的字段；只追加缺失字段，不覆盖既有类的 CLP，
 * 但首次创建时会应用私有 CLP，确保岗位和授权记录只能经 BFF 访问。
 * @param {string} className 需要补齐字段的 Parse 类名。
 * @param {Array<{name: string, type: string, options?: Record<string, unknown>}>} fields 平台维护的字段定义。
 * @returns {Promise<{created: boolean, fields: string[]}>} 新建状态和本次实际补齐的字段名称。
 * @throws {Error} Parse Schema 查询或更新失败时向调用方抛出。
 */
async function ensureSchemaFields(className, fields) {
  const schemas = await Parse.Schema.all(master);
  const definition = schemas.find((schema) => schema.className === className);
  const existingFields = definition?.fields || {};
  const missingFields = fields.filter((field) => !existingFields[field.name]);
  if (definition && !missingFields.length) return { created: false, fields: [] };

  const schema = new Parse.Schema(className);
  for (const field of definition ? missingFields : fields) {
    schema.addField(field.name, field.type, field.options || {});
  }
  if (definition) await schema.update(master);
  else {
    schema.setCLP(new Parse.CLP());
    await schema.save(master);
  }
  return { created: !definition, fields: (definition ? missingFields : fields).map((field) => field.name) };
}

/**
 * 确保旧部署中 Role 与 AllotPermission 已具备岗位页面和逐页按钮授权所需字段。
 * @returns {Promise<{role: {created: boolean, fields: string[]}, permission: {created: boolean, fields: string[]}}>} 两类配置 Schema 的补齐摘要。
 * @throws {Error} Schema 操作失败时向 API 调用方抛出，由统一错误中间件处理。
 */
async function ensurePositionInfrastructure() {
  const [role, permission] = await Promise.all([
    ensureSchemaFields(ROLE_CLASS, [
      { name: "systemKey", type: "String" },
      { name: "name", type: "String", options: { required: true } },
      { name: "company", type: "Pointer", options: { targetClass: "Company" } },
      { name: "module", type: "Array" },
      { name: "positionManaged", type: "Boolean" },
    ]),
    ensureSchemaFields(ALLOT_PERMISSION_CLASS, [
      { name: "systemKey", type: "String" },
      { name: "name", type: "String" },
      { name: "company", type: "Pointer", options: { targetClass: "Company" } },
      { name: "role", type: "Pointer", options: { targetClass: ROLE_CLASS } },
      { name: "routes", type: "Array" },
      { name: "permissions", type: "Array" },
      { name: "routePermissions", type: "Object" },
      { name: "positionManaged", type: "Boolean" },
    ]),
  ]);
  return { role, permission };
}

/**
 * 以批量分页方式加载当前 Company 的配置记录，避免 Parse 单次查询上限导致岗位页面数据不完整。
 * @param {string} className 需要查询的 Parse 类名。
 * @param {string} companyId 当前可信会话的 Company objectId。
 * @param {string[]} [include=[]] 需要加载的关联字段名称。
 * @returns {Promise<Parse.Object[]>} 同租户配置记录数组。
 * @throws {import("../lib/http-error").HttpError} 记录数超过安全上限时抛出 400。
 */
async function listTenantRecords(className, companyId, include = []) {
  const records = [];
  for (let skip = 0; skip < MAX_CONFIGURATION_RECORDS; skip += QUERY_BATCH_SIZE) {
    const query = new Parse.Query(className);
    query.equalTo("company", pointer("Company", companyId));
    if (include.length) query.include(include);
    query.limit(QUERY_BATCH_SIZE);
    query.skip(skip);
    const batch = await query.find(master);
    records.push(...batch);
    if (batch.length < QUERY_BATCH_SIZE) return records;
  }
  throw badRequest("岗位或路由配置数量超过当前安全加载上限，请分批处理");
}

/**
 * 判断 Role 是否由平台基础配置拥有。系统角色不能在岗位页面中修改或删除，避免把系统管理员权限降级。
 * @param {Parse.Object} role 当前 Company 下的 Role 记录。
 * @returns {boolean} 存在非空 systemKey 时返回 true。
 */
function isSystemRole(role) {
  return typeof role.get("systemKey") === "string" && Boolean(role.get("systemKey").trim());
}

/**
 * 规范化一个岗位的逐页授权数组。每个选中页面都必须包含查看数据权限，才能保证该页可实际读取业务数据。
 * @param {unknown} value 岗位表单中的 pagePermissions 数组。
 * @returns {Array<{routeId: string, permissions: string[]}>} 去重、排序后的安全逐页授权配置。
 * @throws {import("../lib/http-error").HttpError} 数据结构、路由标识或按钮权限无效时抛出 400。
 */
function normalizePagePermissions(value) {
  if (!Array.isArray(value)) throw badRequest("页面权限必须是数组");
  if (value.length > MAX_POSITION_PAGES) throw badRequest(`单个岗位最多可配置 ${MAX_POSITION_PAGES} 个页面`);
  const seenRouteIds = new Set();
  const result = [];

  for (const entry of value) {
    if (!isRecord(entry)) throw badRequest("页面权限项必须是对象");
    const routeId = normalizeObjectId(entry.routeId, "页面标识");
    if (seenRouteIds.has(routeId)) throw badRequest("同一岗位不能重复配置同一个页面");
    if (!Array.isArray(entry.permissions)) throw badRequest("页面按钮权限必须是数组");
    const permissions = [...new Set(entry.permissions)];
    if (permissions.some((permission) => typeof permission !== "string" || !BUTTON_PERMISSION_SET.has(permission))) {
      throw badRequest("页面按钮权限包含不支持的权限标识");
    }
    if (!permissions.includes("permission:query")) {
      throw badRequest("已选择的页面必须包含“查看数据”权限");
    }
    seenRouteIds.add(routeId);
    result.push({ routeId, permissions: BUTTON_PERMISSION_CODES.filter((permission) => permissions.includes(permission)) });
  }

  return result;
}

/**
 * 规范化新增或编辑岗位的请求体；编辑时未提交的字段保持不变。
 * @param {unknown} input HTTP 请求体。
 * @param {boolean} editing 是否处于编辑场景。
 * @returns {{name?: string, pagePermissions?: Array<{routeId: string, permissions: string[]}>}} 已验证的岗位表单字段。
 * @throws {import("../lib/http-error").HttpError} 请求体或字段格式无效时抛出 400。
 */
function normalizePositionInput(input, editing) {
  if (!isRecord(input)) throw badRequest("岗位配置必须是对象");
  const result = {};
  if (!editing || Object.prototype.hasOwnProperty.call(input, "name")) result.name = normalizePositionName(input.name);
  if (!editing || Object.prototype.hasOwnProperty.call(input, "pagePermissions")) {
    result.pagePermissions = normalizePagePermissions(input.pagePermissions);
  }
  return result;
}

/**
 * 从 Module 与 Route 记录生成可用于岗位页面的业务页面选项，并建立页面所属模块索引。
 * 平台基础路由固定只对系统管理员开放，因此不会出现在可下放给普通岗位的列表中。
 * @param {Parse.Object[]} modules 当前 Company 的模块记录，需包含 routes 关联。
 * @param {Parse.Object[]} routes 当前 Company 的 Route 记录。
 * @returns {{routeOptions: Array<{objectId: string, name: string, path: string, targetClass: string, moduleId: string | null, moduleName: string}>, routeById: Map<string, Parse.Object>, moduleByRouteId: Map<string, Parse.Object>}} 页面配置所需的安全索引。
 */
function buildRouteCatalog(modules, routes) {
  const moduleByRouteId = new Map();
  for (const module of modules) {
    for (const route of module.get("routes") || []) {
      const routeId = pointerId(route);
      if (routeId && !moduleByRouteId.has(routeId)) moduleByRouteId.set(routeId, module);
    }
  }

  const routeById = new Map();
  const routeOptions = routes
    .filter((route) => !String(route.get("systemKey") || "").startsWith("system."))
    .map((route) => {
      const parentModule = moduleByRouteId.get(route.id);
      routeById.set(route.id, route);
      return {
        objectId: route.id,
        name: route.get("name") || "未命名页面",
        path: route.get("path") || "",
        targetClass: route.get("targetClass") || "",
        moduleId: parentModule?.id || null,
        moduleName: parentModule?.get("name") || "未分组页面",
        rank: Number(route.get("rank")) || 0,
        moduleRank: Number(parentModule?.get("rank")) || 0,
      };
    })
    .sort(
      (left, right) =>
        left.moduleRank - right.moduleRank ||
        left.moduleName.localeCompare(right.moduleName, "zh-CN") ||
        left.rank - right.rank ||
        left.name.localeCompare(right.name, "zh-CN")
    )
    .map(({ rank, moduleRank, ...route }) => route);
  return { routeOptions, routeById, moduleByRouteId };
}

/**
 * 验证页面授权仅指向当前 Company 的可下放业务页面，不能把系统管理页或其他租户页面写入岗位。
 * @param {Array<{routeId: string, permissions: string[]}>} pagePermissions 已规范化的逐页授权数据。
 * @param {Map<string, Parse.Object>} routeById 当前 Company 可配置页面索引。
 * @returns {void} 所有路由均有效时正常返回。
 * @throws {import("../lib/http-error").HttpError} 页面不存在、不是业务页或不属于当前企业时抛出 400。
 */
function assertValidPagePermissions(pagePermissions, routeById) {
  for (const page of pagePermissions) {
    if (!routeById.has(page.routeId)) throw badRequest("所选页面不存在、不是可下放的业务页面或不属于当前企业");
  }
}

/**
 * 从 AllotPermission 记录中读取某个岗位的逐页按钮权限，并优先采用岗位管理页保存的 routePermissions。
 * @param {Parse.Object[]} permissionRecords 当前 Company 全部 AllotPermission 记录。
 * @param {string} roleId 目标岗位 Role objectId。
 * @param {Set<string>} allowedRouteIds 当前岗位 Role.module 中允许访问的 Route objectId 集合。
 * @returns {Array<{routeId: string, permissions: string[]}>} 仅包含当前岗位可访问页面的逐页按钮权限。
 */
function collectPagePermissions(permissionRecords, roleId, allowedRouteIds) {
  const permissionsByRouteId = new Map();
  const relevant = permissionRecords.filter((record) => pointerId(record.get("role")) === roleId);
  const managed = relevant.filter((record) => record.get("positionManaged") === true);
  const sources = managed.length ? managed : relevant;

  for (const record of sources) {
    const routePermissions = isRecord(record.get("routePermissions")) ? record.get("routePermissions") : null;
    const fallbackPermissions = Array.isArray(record.get("permissions")) ? record.get("permissions") : [];
    for (const route of record.get("routes") || []) {
      const routeId = pointerId(route);
      if (!routeId || !allowedRouteIds.has(routeId)) continue;
      const pagePermissions = Array.isArray(routePermissions?.[routeId]) ? routePermissions[routeId] : fallbackPermissions;
      permissionsByRouteId.set(
        routeId,
        BUTTON_PERMISSION_CODES.filter((permission) => pagePermissions.includes(permission))
      );
    }
  }

  return [...permissionsByRouteId.entries()]
    .map(([routeId, permissions]) => ({ routeId, permissions }))
    .sort((left, right) => left.routeId.localeCompare(right.routeId));
}

/**
 * 将 Role 记录转换为岗位管理页面可用的脱敏 DTO。
 * @param {Parse.Object} role 当前 Company 的 Role 记录。
 * @param {Parse.Object[]} permissionRecords 当前 Company 的 AllotPermission 记录。
 * @param {Set<string>} configuredRouteIds 当前 Company 可下放页面的 Route objectId 集合。
 * @returns {{objectId: string, name: string, pagePermissions: Array<{routeId: string, permissions: string[]}>, positionManaged: boolean}} 岗位安全 DTO。
 */
function positionDto(role, permissionRecords, configuredRouteIds) {
  const allowedRouteIds = new Set(
    (role.get("module") || [])
      .map(pointerId)
      .filter((id) => id && configuredRouteIds.has(id))
  );
  return {
    objectId: role.id,
    name: role.get("name") || "未命名岗位",
    pagePermissions: collectPagePermissions(permissionRecords, role.id, allowedRouteIds),
    positionManaged: role.get("positionManaged") === true,
  };
}

/**
 * 查询岗位列表、可下放业务页面以及逐页按钮权限，用于岗位管理页首次加载或刷新。
 * @param {{companyId: string, isAdmin?: boolean}} auth authenticate 中间件提供的可信认证上下文。
 * @returns {Promise<{positions: Array<Record<string, unknown>>, routes: Array<Record<string, unknown>>, buttonPermissions: string[]}>} 岗位、页面和按钮权限配置数据。
 * @throws {import("../lib/http-error").HttpError} 非系统管理员时抛出 403；配置读取失败时向调用方抛出。
 */
async function getPositionOverview(auth) {
  assertSystemAdministrator(auth);
  await ensurePositionInfrastructure();
  const [roles, permissions, modules, routes] = await Promise.all([
    listTenantRecords(ROLE_CLASS, auth.companyId),
    listTenantRecords(ALLOT_PERMISSION_CLASS, auth.companyId, ["role", "routes"]),
    listTenantRecords(MODULE_CLASS, auth.companyId, ["routes"]),
    listTenantRecords(ROUTE_CLASS, auth.companyId),
  ]);
  const catalog = buildRouteCatalog(modules, routes);
  const configuredRouteIds = new Set(catalog.routeOptions.map((route) => route.objectId));
  return {
    positions: roles
      .filter((role) => !isSystemRole(role))
      .map((role) => positionDto(role, permissions, configuredRouteIds))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    routes: catalog.routeOptions,
    buttonPermissions: [...BUTTON_PERMISSION_CODES],
  };
}

/**
 * 查询并验证当前 Company 内一个可维护岗位。系统岗位永远不允许由普通岗位配置流程修改。
 * @param {{companyId: string}} auth 可信认证上下文。
 * @param {string} positionId 待查询 Role objectId。
 * @returns {Promise<Parse.Object>} 可编辑的岗位 Role 记录。
 * @throws {import("../lib/http-error").HttpError} 岗位不存在、跨企业或属于系统角色时抛出 404/403。
 */
async function getTenantPosition(auth, positionId) {
  const id = normalizeObjectId(positionId, "岗位标识");
  const query = new Parse.Query(ROLE_CLASS);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.equalTo("objectId", id);
  const role = await query.first(master);
  if (!role) throw notFound("岗位不存在或不属于当前企业");
  if (isSystemRole(role)) throw forbidden("系统内置岗位不能在此处修改");
  return role;
}

/**
 * 确认岗位名称在当前 Company 内唯一。系统角色与普通岗位共享同一命名空间，避免成员选择时歧义。
 * @param {{companyId: string}} auth 可信认证上下文。
 * @param {string} name 已规范化的岗位名称。
 * @param {string | undefined} excludedId 编辑岗位时需排除的当前 Role objectId。
 * @returns {Promise<void>} 名称可用时正常返回。
 * @throws {import("../lib/http-error").HttpError} 重名时抛出 400。
 */
async function assertUniquePositionName(auth, name, excludedId) {
  const query = new Parse.Query(ROLE_CLASS);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.equalTo("name", name);
  const found = await query.first(master);
  if (found && found.id !== excludedId) throw badRequest("当前企业内已存在同名岗位");
}

/**
 * 读取当前租户的页面目录，为岗位保存过程提供受控的 Route 与 Module Pointer。
 * @param {{companyId: string}} auth 可信认证上下文。
 * @returns {Promise<{routeById: Map<string, Parse.Object>, moduleByRouteId: Map<string, Parse.Object>}>} 当前 Company 可下放业务页面与其模块索引。
 * @throws {Error} Parse 配置读取失败时向调用方抛出。
 */
async function loadPositionRouteCatalog(auth) {
  const [modules, routes] = await Promise.all([
    listTenantRecords(MODULE_CLASS, auth.companyId, ["routes"]),
    listTenantRecords(ROUTE_CLASS, auth.companyId),
  ]);
  const catalog = buildRouteCatalog(modules, routes);
  const allowedRouteIds = new Set(catalog.routeOptions.map((route) => route.objectId));
  return {
    routeById: new Map([...catalog.routeById.entries()].filter(([routeId]) => allowedRouteIds.has(routeId))),
    moduleByRouteId: catalog.moduleByRouteId,
  };
}

/**
 * 保存岗位可见页面以及按页面区分的按钮权限。Role.module 控制菜单/路由可见性，AllotPermission
 * 的 routePermissions 控制服务端业务操作授权；二者同时写入，避免只隐藏菜单却仍可直接调用接口。
 * @param {{companyId: string}} auth 可信认证上下文。
 * @param {Parse.Object} role 已保存的可维护 Role 记录。
 * @param {Array<{routeId: string, permissions: string[]}>} pagePermissions 已验证的逐页授权配置。
 * @param {{routeById: Map<string, Parse.Object>, moduleByRouteId: Map<string, Parse.Object>}} catalog 当前租户受控页面目录。
 * @returns {Promise<void>} Role 和 AllotPermission 保存完成后兑现。
 * @throws {Error} Parse 写入失败时向调用方抛出；调用方会在统一 API 错误路径中处理。
 */
async function savePositionPermissions(auth, role, pagePermissions, catalog) {
  assertValidPagePermissions(pagePermissions, catalog.routeById);
  const selectedRouteIds = pagePermissions.map((page) => page.routeId);
  const selectedRoutePointers = selectedRouteIds.map((routeId) => pointer(ROUTE_CLASS, routeId));
  const selectedModuleIds = new Set(
    selectedRouteIds.map((routeId) => catalog.moduleByRouteId.get(routeId)?.id).filter(Boolean)
  );
  const modulePointers = [...selectedModuleIds].map((moduleId) => pointer(MODULE_CLASS, moduleId));
  role.set("module", [...modulePointers, ...selectedRoutePointers]);
  role.set("positionManaged", true);
  await role.save(null, master);

  const permissionsByRoute = Object.fromEntries(
    pagePermissions.map((page) => [page.routeId, [...page.permissions]])
  );
  const allPermissions = BUTTON_PERMISSION_CODES.filter((permission) =>
    pagePermissions.some((page) => page.permissions.includes(permission))
  );
  const existingQuery = new Parse.Query(ALLOT_PERMISSION_CLASS);
  existingQuery.equalTo("company", pointer("Company", auth.companyId));
  existingQuery.equalTo("role", pointer(ROLE_CLASS, role.id));
  existingQuery.equalTo("positionManaged", true);
  existingQuery.limit(10);
  const managedPermissions = await existingQuery.find(master);
  const permission = managedPermissions.shift() || new (Parse.Object.extend(ALLOT_PERMISSION_CLASS))();
  permission.set("company", pointer("Company", auth.companyId));
  permission.set("role", pointer(ROLE_CLASS, role.id));
  permission.set("name", `${role.get("name") || "岗位"}页面权限`);
  permission.set("routes", selectedRoutePointers);
  permission.set("permissions", allPermissions);
  permission.set("routePermissions", permissionsByRoute);
  permission.set("positionManaged", true);
  await permission.save(null, master);
  await Promise.all(managedPermissions.map((record) => record.destroy(master)));
}

/**
 * 创建一个普通岗位，并同时写入其页面访问与逐页按钮权限。
 * @param {{companyId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {Record<string, unknown>} input 含 name 与 pagePermissions 的岗位表单。
 * @returns {Promise<{objectId: string, name: string, pagePermissions: Array<{routeId: string, permissions: string[]}>, positionManaged: boolean}>} 新建岗位安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 非管理员、名称重复或页面配置非法时抛出对应 HTTP 错误。
 */
async function createPosition(auth, input) {
  assertSystemAdministrator(auth);
  await ensurePositionInfrastructure();
  const normalized = normalizePositionInput(input, false);
  await assertUniquePositionName(auth, normalized.name);
  const catalog = await loadPositionRouteCatalog(auth);
  assertValidPagePermissions(normalized.pagePermissions, catalog.routeById);
  const Role = Parse.Object.extend(ROLE_CLASS);
  const role = new Role();
  role.set("name", normalized.name);
  role.set("company", pointer("Company", auth.companyId));
  role.set("positionManaged", true);
  await role.save(null, master);
  await savePositionPermissions(auth, role, normalized.pagePermissions, catalog);
  return {
    objectId: role.id,
    name: role.get("name") || normalized.name,
    pagePermissions: normalized.pagePermissions,
    positionManaged: true,
  };
}

/**
 * 更新一个普通岗位的名称和/或页面按钮权限。未提交 pagePermissions 时保留既有授权，支持仅改名。
 * @param {{companyId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {string} positionId 待编辑 Role objectId。
 * @param {Record<string, unknown>} input 岗位编辑表单。
 * @returns {Promise<{objectId: string, name: string, pagePermissions: Array<{routeId: string, permissions: string[]}>, positionManaged: boolean}>} 更新后的岗位安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 非管理员、系统岗位、重名或页面配置非法时抛出对应 HTTP 错误。
 */
async function updatePosition(auth, positionId, input) {
  assertSystemAdministrator(auth);
  await ensurePositionInfrastructure();
  const role = await getTenantPosition(auth, positionId);
  const normalized = normalizePositionInput(input, true);
  if (normalized.name !== undefined) {
    await assertUniquePositionName(auth, normalized.name, role.id);
    role.set("name", normalized.name);
  }
  if (normalized.pagePermissions !== undefined) {
    const catalog = await loadPositionRouteCatalog(auth);
    await savePositionPermissions(auth, role, normalized.pagePermissions, catalog);
    return {
      objectId: role.id,
      name: role.get("name") || "未命名岗位",
      pagePermissions: normalized.pagePermissions,
      positionManaged: true,
    };
  }
  role.set("positionManaged", true);
  await role.save(null, master);
  const overview = await getPositionOverview(auth);
  return overview.positions.find((position) => position.objectId === role.id) || {
    objectId: role.id,
    name: role.get("name") || "未命名岗位",
    pagePermissions: [],
    positionManaged: true,
  };
}

/**
 * 删除一个未被成员使用的普通岗位，同时清理该岗位所有逐页授权记录。系统岗位和被引用岗位均不可删除。
 * @param {{companyId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {string} positionId 待删除 Role objectId。
 * @returns {Promise<void>} 权限记录和岗位均删除完成后兑现。
 * @throws {import("../lib/http-error").HttpError} 非管理员、岗位被成员引用或岗位不存在时抛出对应 HTTP 错误。
 */
async function deletePosition(auth, positionId) {
  assertSystemAdministrator(auth);
  await ensurePositionInfrastructure();
  const role = await getTenantPosition(auth, positionId);
  const memberQuery = new Parse.Query(Parse.User);
  memberQuery.equalTo("company", pointer("Company", auth.companyId));
  memberQuery.equalTo("role", pointer(ROLE_CLASS, role.id));
  if (await memberQuery.count(master)) throw badRequest("该岗位仍被成员使用，请先为相关成员重新分配岗位");

  const permissionsQuery = new Parse.Query(ALLOT_PERMISSION_CLASS);
  permissionsQuery.equalTo("company", pointer("Company", auth.companyId));
  permissionsQuery.equalTo("role", pointer(ROLE_CLASS, role.id));
  permissionsQuery.limit(MAX_CONFIGURATION_RECORDS);
  const permissions = await permissionsQuery.find(master);
  await Promise.all(permissions.map((permission) => permission.destroy(master)));
  await role.destroy(master);
}

module.exports = {
  BUTTON_PERMISSION_CODES,
  ensurePositionInfrastructure,
  getPositionOverview,
  createPosition,
  updatePosition,
  deletePosition,
};
