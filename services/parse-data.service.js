const Parse = require("parse/node");
const { badRequest, forbidden, notFound, unauthorized } = require("../lib/http-error");
const { initializeParse } = require("./parse-runtime");
const { ORGANIZATION_CLASS, resolveAccessibleOrganizationIds } = require("./organization.service");

initializeParse();

const master = { useMasterKey: true };
const CLASS_NAME_PATTERN = /^_?[A-Za-z][A-Za-z0-9_]*$/;
const BLOCKED_CLASSES = new Set([
  "LoginActivity",
  "_Session",
  "_Installation",
  "_Role",
  "_PushStatus",
  "_JobStatus",
]);
const PROTECTED_SCHEMA_CLASSES = new Set([
  "LoginActivity",
  "Company",
  "Role",
  "Module",
  "Route",
  "Schema",
  "AllotPermission",
  "Permission",
  "AntdIcon",
  ORGANIZATION_CLASS,
]);
const CONFIGURATION_CLASSES = new Set([
  "Company",
  "Role",
  "Module",
  "Route",
  "Schema",
  "AllotPermission",
  ORGANIZATION_CLASS,
]);
const GLOBAL_READ_CLASSES = new Set(["AntdIcon", "Permission"]);
const USER_PRIVATE_FIELDS = new Set([
  "name",
  "nickname",
  "email",
  "avatar",
  "systemOptions",
]);
const SYSTEM_OPTIONS_FIELDS = new Set([
  "theme",
  "layout",
  "colorPreset",
  "primaryColor",
  "canvasColor",
  "surfaceColor",
  "inkColor",
  "textColor",
  "mutedColor",
  "borderColor",
  "successColor",
  "warningColor",
  "dangerColor",
  "glassEffect",
  "showLogo",
  "logoURL",
  "showTags",
  "refresh",
  "fullScreen",
]);
const SYSTEM_OPTIONS_COLOR_FIELDS = new Set([
  "primaryColor",
  "canvasColor",
  "surfaceColor",
  "inkColor",
  "textColor",
  "mutedColor",
  "borderColor",
  "successColor",
  "warningColor",
  "dangerColor",
]);
const SYSTEM_OPTIONS_BOOLEAN_FIELDS = new Set([
  "glassEffect",
  "showLogo",
  "showTags",
  "refresh",
  "fullScreen",
]);
const SYSTEM_OPTIONS_PRESETS = new Set(["ocean", "emerald", "violet", "sunset", "slate"]);
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
/**
 * 成员岗位、关联组织与组织数据范围只能经受控成员管理接口修改。通用数据 API 不得绕过
 * 同租户岗位校验、系统岗位保护或多组织范围校验。
 */
const MEMBER_MANAGED_USER_FIELDS = new Set([
  "role",
  "organization",
  "organizationIds",
  "organizationScopes",
  "organizationAdmin",
]);
const FORBIDDEN_ATTRIBUTES = new Set([
  "objectId",
  "createdAt",
  "updatedAt",
  "ACL",
  "sessionToken",
  "authData",
  "_hashed_password",
]);
const RESERVED_SCHEMA_FIELDS = new Set([
  "ACL",
  "authData",
  "company",
  "createdAt",
  "objectId",
  "sessionToken",
  "updatedAt",
]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

let schemaCache = null;
let schemaCacheExpiresAt = 0;

function ensureClassName(className) {
  if (typeof className !== "string" || !CLASS_NAME_PATTERN.test(className)) {
    throw badRequest("Invalid class name");
  }
  if (BLOCKED_CLASSES.has(className)) {
    throw forbidden("This Parse system class is not available through the API");
  }
  return className;
}

function objectId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || value.objectId || null;
}

function pointer(className, id) {
  if (!id) throw badRequest(`A valid ${className} identifier is required`);
  return { __type: "Pointer", className, objectId: id };
}

function resolveClass(className) {
  return className === "_User" ? Parse.User : className;
}

function isConfigurationClass(className) {
  return className === "_User" || CONFIGURATION_CLASSES.has(className);
}

function hasDangerousKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasDangerousKey);
  return Object.keys(value).some(
    (key) => DANGEROUS_KEYS.has(key) || hasDangerousKey(value[key])
  );
}

function normalizeValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Parse.Object) {
    return pointer(value.className, value.id);
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (hasDangerousKey(value)) throw badRequest("Object payload contains a reserved key");
  if (value.objectId && value.className) {
    return pointer(value.className, value.objectId);
  }
  if (value.__type === "Pointer" && value.className && value.objectId) {
    return pointer(value.className, value.objectId);
  }

  return Object.entries(value).reduce((result, [key, child]) => {
    result[key] = normalizeValue(child);
    return result;
  }, {});
}

/**
 * 清洗当前用户的界面偏好对象，避免通用用户更新接口把未审核字段或不可信 CSS 值写入账户资料。
 * @param {unknown} value 前端提交的 systemOptions 对象；必须是普通对象而不是数组。
 * @returns {Record<string, unknown>} 只包含平台支持字段的规范化主题配置；未知字段会被忽略。
 * @throws {import("../lib/http-error").HttpError} 配置结构、颜色、枚举或字符串长度非法时抛出 400。
 */
function sanitizeSystemOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasDangerousKey(value)) {
    throw badRequest("systemOptions must be a plain object");
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SYSTEM_OPTIONS_FIELDS.has(key) || child === undefined) continue;

    if (SYSTEM_OPTIONS_COLOR_FIELDS.has(key)) {
      if (child !== "" && (typeof child !== "string" || !HEX_COLOR_PATTERN.test(child))) {
        throw badRequest(`${key} must be an #RRGGBB color or an empty string`);
      }
      result[key] = typeof child === "string" ? child.toLowerCase() : child;
      continue;
    }

    if (SYSTEM_OPTIONS_BOOLEAN_FIELDS.has(key)) {
      if (typeof child !== "boolean") throw badRequest(`${key} must be a boolean`);
      result[key] = child;
      continue;
    }

    if (key === "theme") {
      if (!["light", "dark"].includes(child)) throw badRequest("theme must be light or dark");
      result[key] = child;
      continue;
    }

    if (key === "layout") {
      if (!["LeftLayout", "TopLayout"].includes(child)) {
        throw badRequest("layout must be LeftLayout or TopLayout");
      }
      result[key] = child;
      continue;
    }

    if (key === "colorPreset") {
      if (!SYSTEM_OPTIONS_PRESETS.has(child)) throw badRequest("Unknown color preset");
      result[key] = child;
      continue;
    }

    if (key === "logoURL") {
      if (typeof child !== "string" || child.length > 2_048) {
        throw badRequest("logoURL must be a string up to 2048 characters");
      }
      result[key] = child;
    }
  }
  return result;
}

function sanitizeSerialized(value, inheritedClassName, isNested = false) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeSerialized(item, undefined, true));
  const className = typeof value.className === "string" ? value.className : inheritedClassName;
  const result = Object.entries(value).reduce((safeValue, [key, child]) => {
    if (!DANGEROUS_KEYS.has(key)) safeValue[key] = sanitizeSerialized(child, undefined, true);
    return safeValue;
  }, {});
  if (className === "_User") {
    delete result.password;
    delete result.sessionToken;
    delete result.authData;
    delete result._hashed_password;
    if (isNested) {
      delete result.email;
      delete result.systemOptions;
    }
  }
  return result;
}

function serialize(record, className) {
  const json = record && typeof record.toJSON === "function" ? record.toJSON() : record;
  return sanitizeSerialized(json, className);
}

async function allSchemas() {
  if (schemaCache && schemaCacheExpiresAt > Date.now()) return schemaCache;
  const schemas = await Parse.Schema.all(master);
  schemaCache = new Map(schemas.map((schema) => [schema.className, schema]));
  schemaCacheExpiresAt = Date.now() + 60_000;
  return schemaCache;
}

function clearSchemaCache() {
  schemaCache = null;
  schemaCacheExpiresAt = 0;
}

async function allowedFields(className) {
  const schema = (await allSchemas()).get(className);
  if (!schema) throw notFound(`Parse class ${className} does not exist`);
  return new Set(Object.keys(schema.fields || {}));
}

async function getAuthContext(userId) {
  const userQuery = new Parse.Query(Parse.User);
  userQuery.include(["company", "role"]);
  const user = await userQuery.get(userId, master).catch(() => null);
  if (!user || user.get("isDelete") === true) {
    throw unauthorized("Your account is unavailable");
  }

  const companyId = objectId(user.get("company"));
  if (!companyId) throw forbidden("Your account is not assigned to a company");

  const companyQuery = new Parse.Query("Company");
  companyQuery.include("admin");
  const company = await companyQuery.get(companyId, master).catch(() => null);
  if (!company) throw forbidden("Your company is unavailable");

  let roleId = objectId(user.get("role"));
  let role = null;
  if (roleId) {
    const roleQuery = new Parse.Query("Role");
    roleQuery.includeAll();
    role = await roleQuery.get(roleId, master).catch(() => null);
    if (role && objectId(role.get("company")) !== companyId) {
      role = null;
      roleId = null;
    }
  }

  const administratorIds = (company.get("admin") || []).map(objectId).filter(Boolean);
  const isAdmin = administratorIds.includes(user.id) || role?.get("systemKey") === "system.administrator";

  return {
    user,
    userId: user.id,
    company,
    companyId,
    role,
    roleId,
    isAdmin,
  };
}

/**
 * 判断业务类是否显式配置了指向 Organization 的组织字段。只有这类表才启用组织范围过滤，
 * 因而不会破坏未纳入组织管理的历史业务数据。
 * @param {string} className 已通过 ensureClassName 校验的 Parse 类名。
 * @returns {Promise<boolean>} 存在 targetClass 为 Organization 的 organization Pointer 字段时返回 true。
 * @throws {Error} Schema 读取失败时抛出，调用方必须中止请求而不能放宽数据范围。
 */
async function isOrganizationScopedClass(className) {
  if (GLOBAL_READ_CLASSES.has(className) || isConfigurationClass(className)) return false;
  const schema = (await allSchemas()).get(className);
  const organizationField = schema?.fields?.organization;
  return organizationField?.type === "Pointer" && organizationField.targetClass === ORGANIZATION_CLASS;
}

/**
 * 在 Company 租户边界基础上追加成员组织范围。系统管理员保持 Company 全量视图；普通成员仅能
 * 读取其被分配组织以及这些组织的全部下级节点的数据。
 * @param {Parse.Query} query 正在构建的 Parse 查询。
 * @param {string} className 已校验的数据类名。
 * @param {{companyId: string, isAdmin?: boolean, user?: Parse.Object, roleId?: string}} auth 可信认证上下文。
 * @returns {Promise<void>} 作用域条件已写入 query 后兑现。
 * @throws {Error} 组织树读取异常时抛出，调用方将安全失败而不会返回未过滤的数据。
 */
async function applyTenantScope(query, className, auth) {
  if (GLOBAL_READ_CLASSES.has(className)) return;

  if (className === "Company") {
    query.equalTo("objectId", auth.companyId);
    return;
  }
  if (className === "_User") {
    query.equalTo("company", pointer("Company", auth.companyId));
    if (!auth.isAdmin) query.equalTo("objectId", auth.userId);
    return;
  }
  if (className === "AllotPermission" && !auth.isAdmin) {
    if (!auth.roleId) throw forbidden("Your account has no role");
    query.equalTo("role", pointer("Role", auth.roleId));
  }

  query.equalTo("company", pointer("Company", auth.companyId));
  if (!(await isOrganizationScopedClass(className))) return;

  const organizationIds = await resolveAccessibleOrganizationIds(auth);
  if (organizationIds === null) return;
  if (!organizationIds.length) {
    // objectId 不可能由正常 UI 生成该保留值；使用永不匹配条件而不是忽略组织范围。
    query.equalTo("objectId", "__organization_scope_empty__");
    return;
  }
  query.containedIn(
    "organization",
    organizationIds.map((organizationId) => pointer(ORGANIZATION_CLASS, organizationId))
  );
}

/**
 * 将服务端授权范围与客户端筛选条件合并为 Parse `$and` 查询。不能在同一个 Query 上依次写入
 * 同名字段：Parse 的 equalTo 会覆盖已有条件，可能让客户端筛选替换 Company、Role 或 Organization
 * 的强制边界。全局类没有授权条件时直接返回筛选查询，避免生成无意义的空 `$and` 分支。
 * @param {Parse.Query} scopeQuery 已应用 Company、角色、当前用户或组织范围的服务端查询。
 * @param {Parse.Query} criteriaQuery 仅包含客户端筛选或可信 objectId 条件的独立查询。
 * @returns {Parse.Query} 同时满足授权范围与附加条件的安全查询。
 */
function combineScopeAndCriteria(scopeQuery, criteriaQuery) {
  return hasQueryConditions(scopeQuery) ? Parse.Query.and(scopeQuery, criteriaQuery) : criteriaQuery;
}

/**
 * 判断 Parse Query 是否包含实际的 `where` 条件。被服务端忽略的 `company` 筛选不会写入查询，
 * 此时无需产生带空分支的 `$and` 结构。
 * @param {Parse.Query} query 待检查的 Parse 查询对象。
 * @returns {boolean} 至少存在一项实际 where 条件时返回 true。
 */
function hasQueryConditions(query) {
  return Object.keys(query.toJSON().where || {}).length > 0;
}

async function authorizeAction(auth, className, action) {
  if (className === ORGANIZATION_CLASS && action !== "query") {
    throw forbidden("组织节点只能通过受控组织管理接口维护");
  }
  if (auth.isAdmin) return;

  if (isConfigurationClass(className)) {
    if (action === "query" && ["Company", "Module", "Route", "Schema", "AllotPermission", "Role", ORGANIZATION_CLASS].includes(className)) {
      return;
    }
    if (className === "_User" && ["query", "edit"].includes(action)) return;
    throw forbidden();
  }

  const routeQuery = new Parse.Query("Route");
  routeQuery.equalTo("targetClass", className);
  routeQuery.equalTo("company", pointer("Company", auth.companyId));
  const route = await routeQuery.first(master);
  if (!route || !auth.roleId) throw forbidden();

  // 新岗位管理页保存 positionManaged 时，Role.module 既是动态菜单来源也是服务端操作的第一道
  // 页面授权边界。这样即使历史 AllotPermission 残留，已移除的页面也不能继续直接调用数据 API。
  if (auth.role?.get("positionManaged") === true) {
    const authorizedRouteIds = new Set((auth.role.get("module") || []).map(objectId).filter(Boolean));
    if (!authorizedRouteIds.has(route.id)) throw forbidden();
  }

  const permissionQuery = new Parse.Query("AllotPermission");
  permissionQuery.equalTo("role", pointer("Role", auth.roleId));
  permissionQuery.containedIn("routes", [pointer("Route", route.id)]);
  permissionQuery.limit(1_000);
  const permissions = await permissionQuery.find(master);
  const requiredPermission = `permission:${action}`;
  const managedPermissions = permissions.filter((permission) => permission.get("positionManaged") === true);
  const effectivePermissions = managedPermissions.length ? managedPermissions : permissions;
  const allowed = effectivePermissions.some((permission) => {
    const routePermissions = permission.get("routePermissions");
    const pagePermissions = Array.isArray(routePermissions?.[route.id])
      ? routePermissions[route.id]
      : permission.get("permissions") || [];
    return pagePermissions.includes(requiredPermission);
  });
  if (!allowed) {
    throw forbidden();
  }
}

async function addFilter(query, className, filter) {
  if (!filter || typeof filter !== "object") throw badRequest("Invalid query filter");
  const { field, operator, value } = filter;
  if (typeof field !== "string" || !field || DANGEROUS_KEYS.has(field)) {
    throw badRequest("Invalid query field");
  }
  // Tenant isolation is authoritative on the server.
  if (field === "company") return;

  const definition = (await allSchemas()).get(className)?.fields?.[field];
  const normalizeFilterValue = (rawValue) => {
    if (definition?.type === "Pointer" && typeof rawValue === "string") {
      return pointer(definition.targetClass, rawValue);
    }
    return normalizeValue(rawValue);
  };

  switch (operator) {
    case "equalTo":
      query.equalTo(field, normalizeFilterValue(value));
      break;
    case "containedIn":
      if (!Array.isArray(value) || value.length > 500) {
        throw badRequest("containedIn accepts at most 500 values");
      }
      query.containedIn(field, value.map(normalizeFilterValue));
      break;
    case "contains":
      if (typeof value !== "string" || value.length > 256) {
        throw badRequest("contains accepts a string up to 256 characters");
      }
      query.contains(field, value);
      break;
    default:
      throw badRequest("Unsupported query operator");
  }
}

/**
 * 在服务端租户、角色和组织范围内执行通用数据查询。客户端筛选始终构建在独立 Query 中，再与
 * 强制范围以 `$and` 合并，确保筛选相同字段也不会覆盖授权约束。
 * @param {{companyId: string, isAdmin?: boolean, userId?: string, roleId?: string}} auth authenticate 中间件提供的可信认证上下文。
 * @param {{className: string, filters?: Array<Record<string, unknown>>, includeAll?: boolean, include?: string[], select?: string[], descending?: string, limit?: number, skip?: number}} input 查询条件；className 必填，filters 最多 50 项。
 * @returns {Promise<{data: Array<Record<string, unknown>>, count: number}>} 已序列化的当前页记录与范围内总数。
 * @throws {import("../lib/http-error").HttpError} 类名、筛选、权限或分页参数不合法时抛出 400/403。
 */
async function queryRecords(auth, input) {
  const className = ensureClassName(input?.className);
  await authorizeAction(auth, className, "query");

  const filters = input?.filters ?? [];
  if (!Array.isArray(filters) || filters.length > 50) {
    throw badRequest("filters 必须是最多 50 项的数组");
  }

  const scopeQuery = new Parse.Query(resolveClass(className));
  await applyTenantScope(scopeQuery, className, auth);
  const filterQuery = new Parse.Query(resolveClass(className));
  for (const filter of filters) {
    await addFilter(filterQuery, className, filter);
  }
  const query = hasQueryConditions(filterQuery) ? combineScopeAndCriteria(scopeQuery, filterQuery) : scopeQuery;

  if (input.includeAll) query.includeAll();
  if (Array.isArray(input.include) && input.include.length) query.include(input.include);
  if (Array.isArray(input.select) && input.select.length) query.select(input.select.slice(0, 50));
  if (input.descending) query.descending(input.descending);

  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const skip = Math.min(Math.max(Number(input.skip) || 0, 0), 100_000);
  query.limit(limit);
  query.skip(skip);

  const [records, count] = await Promise.all([query.find(master), query.count(master)]);
  return {
    data: records.map((record) => serialize(record, className)),
    count,
  };
}

async function sanitizeAttributes(className, attributes, auth, mode) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw badRequest("attributes must be an object");
  }
  if (hasDangerousKey(attributes)) throw badRequest("Object payload contains a reserved key");

  const fields = await allowedFields(className);
  const result = {};
  const allowUserCredentials = className === "_User" && auth.isAdmin && mode === "create";

  for (const [key, value] of Object.entries(attributes)) {
    if (FORBIDDEN_ATTRIBUTES.has(key) || key === "company") continue;
    if (className === "_User" && MEMBER_MANAGED_USER_FIELDS.has(key)) {
      throw forbidden("成员岗位与组织范围只能通过成员管理功能维护");
    }
    if (className === "_User" && key === "systemOptions") {
      // systemOptions 是用户私有偏好，不依赖低代码 Schema 是否已被旧数据库补齐；
      // 这里由 BFF 维护显式字段契约，避免前端把整个用户对象作为写入边界。
      result[key] = sanitizeSystemOptions(value);
      continue;
    }
    if (className === "_User" && !auth.isAdmin && !USER_PRIVATE_FIELDS.has(key)) {
      throw forbidden("You can only edit your own profile fields");
    }
    if (!fields.has(key) && !(allowUserCredentials && ["username", "password", "email"].includes(key))) {
      throw badRequest(`Field ${key} is not part of ${className}`);
    }
    result[key] = normalizeValue(value);
  }

  await validateTenantPointers(auth, result);
  return result;
}

function collectPointers(value, pointers = [], depth = 0) {
  if (depth > 10) throw badRequest("Object payload is nested too deeply");
  if (!value || typeof value !== "object") return pointers;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPointers(item, pointers, depth + 1));
    return pointers;
  }
  if (value.__type === "Pointer" && value.className && value.objectId) {
    pointers.push(value);
    return pointers;
  }
  Object.values(value).forEach((item) => collectPointers(item, pointers, depth + 1));
  return pointers;
}

/**
 * 校验写入载荷中的所有 Pointer 都位于当前会话允许的租户与组织范围内。每个 objectId 条件在独立
 * Query 中构建，防止它覆盖 applyTenantScope 添加的当前用户或组织范围条件。
 * @param {{companyId: string, isAdmin?: boolean, userId?: string, roleId?: string}} auth 可信认证上下文。
 * @param {Record<string, unknown>} attributes 已完成基础字段清洗的待写入属性。
 * @returns {Promise<void>} 所有 Pointer 合法时兑现。
 * @throws {import("../lib/http-error").HttpError} 引用数量超限、格式错误或存在越权引用时抛出 400/403。
 */
async function validateTenantPointers(auth, attributes) {
  const pointers = collectPointers(attributes);
  const uniquePointers = new Map();
  for (const value of pointers) {
    const className = ensureClassName(value.className);
    uniquePointers.set(`${className}:${value.objectId}`, { className, objectId: value.objectId });
  }
  if (uniquePointers.size > 100) throw badRequest("Too many referenced records");

  await Promise.all(
    [...uniquePointers.values()].map(async (value) => {
      if (GLOBAL_READ_CLASSES.has(value.className)) return;
      const scopeQuery = new Parse.Query(resolveClass(value.className));
      await applyTenantScope(scopeQuery, value.className, auth);
      const objectIdQuery = new Parse.Query(resolveClass(value.className));
      objectIdQuery.equalTo("objectId", value.objectId);
      const query = combineScopeAndCriteria(scopeQuery, objectIdQuery);
      const record = await query.first(master);
      if (!record) throw forbidden("A referenced record is outside your tenant scope");
    })
  );
}

function setAttributes(record, attributes) {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) record.set(key, value);
  }
}

/**
 * 校验并补齐组织范围业务记录的 organization 字段。普通成员只能写入被授权的组织；未显式选择时，
 * 系统使用其主组织作为安全默认值。系统管理员仍需提供一个同租户有效组织，避免产生无法授权的数据。
 * @param {{isAdmin?: boolean, user?: Parse.Object}} auth 可信认证上下文。
 * @param {string} className 当前写入的 Parse 类名。
 * @param {Record<string, unknown>} attributes 已通过字段和租户 Pointer 校验的属性对象，会被原地补齐。
 * @param {Parse.Object | undefined} existingRecord 编辑场景中的当前记录；创建场景传 undefined。
 * @returns {Promise<void>} 组织字段通过校验或完成补齐后兑现。
 * @throws {import("../lib/http-error").HttpError} 组织缺失、不可用或超出成员范围时抛出 400/403。
 */
async function applyOrganizationWriteScope(auth, className, attributes, existingRecord) {
  if (!(await isOrganizationScopedClass(className))) return;
  const requestedOrganizationId = objectId(attributes.organization);
  let organizationId = requestedOrganizationId || objectId(existingRecord?.get("organization"));
  if (!organizationId && !auth.isAdmin) organizationId = objectId(auth.user?.get("organization"));
  if (!organizationId) throw badRequest("组织范围业务数据必须指定所属组织");

  // 新建记录或主动迁移记录时，必须写入同企业且仍启用的组织。编辑历史记录时若未调整其
  // 已停用组织，仍允许完成归档等必要维护，避免停用组织造成存量数据无法修正。
  if (!existingRecord || requestedOrganizationId) {
    const organizationQuery = new Parse.Query(ORGANIZATION_CLASS);
    organizationQuery.equalTo("company", pointer("Company", auth.companyId));
    organizationQuery.equalTo("objectId", organizationId);
    const organization = await organizationQuery.first(master);
    if (!organization) throw forbidden("所选组织不属于当前企业");
    if (organization.get("isActive") === false) throw badRequest("所选组织已停用，不能承接新的业务数据");
  }

  const accessibleOrganizationIds = await resolveAccessibleOrganizationIds(auth);
  if (accessibleOrganizationIds !== null && !accessibleOrganizationIds.includes(organizationId)) {
    throw forbidden("所选组织不在当前账号的管理范围内");
  }
  attributes.organization = pointer(ORGANIZATION_CLASS, organizationId);
}

/**
 * 在可信会话允许的范围内获取一条记录。目标 objectId 与强制 Company/角色/组织条件采用独立 Query
 * 再合并，避免同名 objectId 条件覆盖普通成员的“仅本人”限制。
 * @param {{companyId: string, isAdmin?: boolean, userId?: string, roleId?: string}} auth 可信认证上下文。
 * @param {string} className 已完成类名校验的数据类。
 * @param {string} id 目标记录 objectId。
 * @returns {Promise<Parse.Object>} 位于授权范围内的 Parse 记录。
 * @throws {import("../lib/http-error").HttpError} 标识缺失或目标不在可访问范围内时抛出 400/404。
 */
async function getScopedRecord(auth, className, id) {
  if (typeof id !== "string" || !id) throw badRequest("A record identifier is required");
  const scopeQuery = new Parse.Query(resolveClass(className));
  await applyTenantScope(scopeQuery, className, auth);
  const objectIdQuery = new Parse.Query(resolveClass(className));
  objectIdQuery.equalTo("objectId", id);
  const query = combineScopeAndCriteria(scopeQuery, objectIdQuery);
  const record = await query.first(master);
  if (!record) throw notFound();
  return record;
}

async function createRecord(auth, classNameInput, attributes) {
  const className = ensureClassName(classNameInput);
  await authorizeAction(auth, className, "insert");
  if (className === "_User" && !auth.isAdmin) throw forbidden();

  const safeAttributes = await sanitizeAttributes(className, attributes, auth, "create");
  await applyOrganizationWriteScope(auth, className, safeAttributes);
  const Record = resolveClass(className);
  const record = new Record();
  setAttributes(record, safeAttributes);

  if (className === "_User") {
    record.set("company", pointer("Company", auth.companyId));
    if (!record.get("username") || !record.get("password")) {
      throw badRequest("username and password are required when creating a user");
    }
    await record.signUp(null, master);
  } else {
    if (!GLOBAL_READ_CLASSES.has(className)) record.set("company", pointer("Company", auth.companyId));
    await record.save(null, master);
  }
  return serialize(record, className);
}

async function updateRecord(auth, classNameInput, id, attributes) {
  const className = ensureClassName(classNameInput);
  await authorizeAction(auth, className, "edit");
  if (className === "_User" && !auth.isAdmin && id !== auth.userId) throw forbidden();

  const record = await getScopedRecord(auth, className, id);
  const safeAttributes = await sanitizeAttributes(className, attributes, auth, "update");
  await applyOrganizationWriteScope(auth, className, safeAttributes, record);
  setAttributes(record, safeAttributes);
  await record.save(null, master);
  return serialize(record, className);
}

async function deleteRecord(auth, classNameInput, id) {
  const className = ensureClassName(classNameInput);
  await authorizeAction(auth, className, "remove");
  if (className === "_User" && id === auth.userId) {
    throw forbidden("You cannot delete your own account");
  }
  const record = await getScopedRecord(auth, className, id);
  await record.destroy(master);
}

function privateClp() {
  return new Parse.CLP();
}

function ensureMutableSchemaClass(className) {
  const safeClassName = ensureClassName(className);
  if (safeClassName.startsWith("_") || PROTECTED_SCHEMA_CLASSES.has(safeClassName)) {
    throw forbidden("This schema is managed by the platform");
  }
  return safeClassName;
}

function schemaOptions(rawOptions = {}) {
  const options = {};
  if (rawOptions.required !== undefined) options.required = Boolean(rawOptions.required);
  if (rawOptions.targetClass) {
    ensureClassName(rawOptions.targetClass);
    options.targetClass = rawOptions.targetClass;
  }
  if (rawOptions.defaultValue !== undefined && rawOptions.defaultValue !== "") {
    options.defaultValue = normalizeValue(rawOptions.defaultValue);
  }
  return options;
}

function addSchemaField(schema, field) {
  if (
    !field ||
    typeof field.name !== "string" ||
    !FIELD_NAME_PATTERN.test(field.name) ||
    DANGEROUS_KEYS.has(field.name) ||
    RESERVED_SCHEMA_FIELDS.has(field.name)
  ) {
    throw badRequest("Invalid schema field name");
  }
  const supportedTypes = new Set([
    "String",
    "Number",
    "Boolean",
    "Date",
    "Object",
    "Array",
    "GeoPoint",
    "Polygon",
    "File",
    "Pointer",
    "Relation",
  ]);
  if (!supportedTypes.has(field.type)) throw badRequest("Unsupported schema field type");
  schema.addField(field.name, field.type, schemaOptions(field.options));
}

/**
 * 阻止将已启用组织范围的数据表退化为仅 Company 隔离。组织字段一旦承载业务数据与成员范围授权，
 * 删除它会使历史记录失去组织边界；需要停用该能力时必须通过受控的数据迁移方案执行。
 * @param {string} className 已通过 ensureMutableSchemaClass 校验的业务类名。
 * @param {string} fieldName 管理员请求删除的字段名。
 * @returns {Promise<void>} 字段非组织范围字段时正常兑现。
 * @throws {import("../lib/http-error").HttpError} 删除当前组织范围字段时抛出 403。
 */
async function assertOrganizationScopeFieldCanBeRemoved(className, fieldName) {
  if (fieldName === "organization" && (await isOrganizationScopedClass(className))) {
    throw forbidden("组织范围字段受平台保护；请先完成受控数据迁移，不能直接删除");
  }
}

async function createSchema(auth, input) {
  const className = ensureMutableSchemaClass(input?.className);
  if (!auth.isAdmin) throw forbidden();
  if ((await allSchemas()).has(className)) throw badRequest(`Parse class ${className} already exists`);

  const schema = new Parse.Schema(className);
  schema.addPointer("company", "Company");
  (input.fields || []).forEach((field) => {
    // The compatibility client still sends this conventional field. The BFF
    // owns it so a caller cannot change its target or omit tenant scoping.
    if (field?.name === "company") {
      if (field.type !== "Pointer" || field.options?.targetClass !== "Company") {
        throw badRequest("The company field is managed by the platform");
      }
      return;
    }
    addSchemaField(schema, field);
  });
  schema.setCLP(privateClp());
  await schema.save(master);
  clearSchemaCache();
  return { className };
}

async function updateSchema(auth, classNameInput, input) {
  const className = ensureMutableSchemaClass(classNameInput);
  if (!auth.isAdmin) throw forbidden();
  if (!(await allSchemas()).has(className)) throw notFound(`Parse class ${className} does not exist`);

  const addFields = input?.addFields ?? [];
  const deleteFields = input?.deleteFields ?? [];
  if (!Array.isArray(addFields) || !Array.isArray(deleteFields) || addFields.length + deleteFields.length > 100) {
    throw badRequest("Schema 字段变更必须是最多 100 项的字段数组");
  }
  const schema = new Parse.Schema(className);
  for (const field of addFields) {
    addSchemaField(schema, field);
  }
  for (const fieldName of deleteFields) {
    if (typeof fieldName !== "string" || !FIELD_NAME_PATTERN.test(fieldName) || RESERVED_SCHEMA_FIELDS.has(fieldName)) {
      throw badRequest("This schema field cannot be deleted");
    }
    await assertOrganizationScopeFieldCanBeRemoved(className, fieldName);
    schema.deleteField(fieldName);
  }
  schema.setCLP(privateClp());
  await schema.update(master);
  clearSchemaCache();
  return { className };
}

async function removeSchema(auth, classNameInput, purge) {
  const className = ensureMutableSchemaClass(classNameInput);
  if (!auth.isAdmin) throw forbidden();
  if (!(await allSchemas()).has(className)) throw notFound(`Parse class ${className} does not exist`);
  const schema = new Parse.Schema(className);
  if (purge) await schema.purge(master);
  await schema.delete(master);
  clearSchemaCache();
}

async function listSchemaDefinitions(auth) {
  if (!auth.isAdmin) throw forbidden();
  const schemas = await allSchemas();
  return [...schemas.values()]
    .filter((schema) => !BLOCKED_CLASSES.has(schema.className))
    .map((schema) => ({
    className: schema.className,
    fields: sanitizeSerialized(schema.fields || {}),
    }));
}

async function assertUserInTenant(auth, userId) {
  if (userId === auth.userId) return;
  if (!auth.isAdmin) throw forbidden();
  await getScopedRecord(auth, "_User", userId);
}

async function hardenAllClassPermissions() {
  const schemas = await allSchemas();
  const changed = [];
  for (const schemaDefinition of schemas.values()) {
    const schema = new Parse.Schema(schemaDefinition.className);
    schema.setCLP(privateClp());
    await schema.update(master);
    changed.push(schemaDefinition.className);
  }
  clearSchemaCache();
  return changed;
}

module.exports = {
  master,
  pointer,
  objectId,
  serialize,
  getAuthContext,
  queryRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  createSchema,
  updateSchema,
  removeSchema,
  listSchemaDefinitions,
  hardenAllClassPermissions,
  clearSchemaCache,
  assertUserInTenant,
};
