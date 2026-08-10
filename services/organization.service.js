"use strict";

const Parse = require("parse/node");
const { badRequest, forbidden, notFound } = require("../lib/http-error");
const { initializeParse } = require("./parse-runtime");

initializeParse();

/** 仅在 BFF 内部使用 Master Key 执行组织架构的受控维护操作。 */
const master = { useMasterKey: true };
/** 组织节点保存的 Parse 类名；一个 Company 对应一棵独立的组织树。 */
const ORGANIZATION_CLASS = "Organization";
/** 单次组织或成员管理接口允许加载的最大配置记录数，避免意外全量读取耗尽内存。 */
const MAX_CONFIGURATION_RECORDS = 10_000;
/** 单批 Parse 查询大小；多批分页可支持中大型企业组织与成员配置。 */
const QUERY_BATCH_SIZE = 1_000;
/** 组织成员管理页单页最大记录数，兼顾管理员操作效率与 Parse 查询负载。 */
const MAX_MEMBER_PAGE_SIZE = 100;
/** 成员列表允许的最大页码，配合单页上限最多支持 100 万名成员的按页维护。 */
const MAX_MEMBER_PAGE = 10_000;
/** 组织类型白名单，覆盖总部、区域、地方与部门等常见企业层级。 */
const ORGANIZATION_TYPES = new Set(["headquarters", "region", "branch", "department", "other"]);

/**
 * 校验并规范化 Parse objectId，防止空值或超长值被用于跨租户查询。
 * @param {unknown} value 来自 URL 或请求体的对象标识。
 * @param {string} label 发生校验错误时展示的字段中文名称。
 * @param {boolean} [required=true] 是否必须提供该标识。
 * @returns {string | null} 合法 objectId；非必填字段未提供时返回 null。
 * @throws {import("../lib/http-error").HttpError} 标识不合法时抛出 400。
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
 * 将可信的类名和 objectId 转换为 Parse Pointer JSON，供 Master Key 查询和保存使用。
 * @param {string} className Parse 类名。
 * @param {string} id 已完成校验的对象标识。
 * @returns {{__type: "Pointer", className: string, objectId: string}} 可保存的 Parse Pointer。
 */
function pointer(className, id) {
  return { __type: "Pointer", className, objectId: id };
}

/**
 * 从 Parse Object、Pointer JSON 或序列化对象中提取 objectId。
 * @param {unknown} value 任意可能表示关联对象的值。
 * @returns {string | null} 可用对象标识；无法提取时返回 null。
 */
function pointerId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || value.objectId || null;
}

/**
 * 校验必填文本字段并限制长度，避免组织名称、账号名等配置被写入无意义内容。
 * @param {unknown} value 原始文本值。
 * @param {string} label 发生校验错误时展示的字段中文名称。
 * @param {number} maxLength 允许的最大字符数，单位为 Unicode 字符。
 * @returns {string} 去除首尾空格后的非空文本。
 * @throws {import("../lib/http-error").HttpError} 文本为空或超长时抛出 400。
 */
function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw badRequest(`${label}不能为空且长度不能超过${maxLength}个字符`);
  }
  return value.trim();
}

/**
 * 规范化可选文本字段；空白内容统一保存为 undefined，避免前端传入空串污染数据。
 * @param {unknown} value 原始文本值。
 * @param {string} label 发生校验错误时展示的字段中文名称。
 * @param {number} maxLength 允许的最大字符数，单位为 Unicode 字符。
 * @returns {string | undefined} 合法文本或 undefined。
 * @throws {import("../lib/http-error").HttpError} 非字符串或超长时抛出 400。
 */
function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw badRequest(`${label}格式无效或长度超过${maxLength}个字符`);
  }
  return value.trim() || undefined;
}

/**
 * 规范化组织排序值；排序只影响显示顺序，不影响数据授权范围。
 * @param {unknown} value 原始排序值。
 * @returns {number} 介于 0 和 999999 之间的整数。
 * @throws {import("../lib/http-error").HttpError} 值不是有限整数或超出范围时抛出 400。
 */
function normalizeRank(value) {
  if (value === undefined || value === null || value === "") return 0;
  const rank = Number(value);
  if (!Number.isInteger(rank) || rank < 0 || rank > 999_999) {
    throw badRequest("排序必须是 0 到 999999 之间的整数");
  }
  return rank;
}

/**
 * 规范化成员列表页码，拒绝负数、小数和超出安全上限的请求，避免大偏移查询耗尽数据库资源。
 * @param {unknown} value URL 查询参数中的页码，允许省略。
 * @returns {number} 介于 1 与 MAX_MEMBER_PAGE 之间的整数页码。
 * @throws {import("../lib/http-error").HttpError} 页码格式错误或超出范围时抛出 400。
 */
function normalizeMemberPage(value) {
  if (value === undefined || value === null || value === "") return 1;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1 || page > MAX_MEMBER_PAGE) {
    throw badRequest(`成员页码必须是 1 到 ${MAX_MEMBER_PAGE} 之间的整数`);
  }
  return page;
}

/**
 * 规范化成员列表单页数量，保持管理员列表响应稳定，避免客户端请求无界成员集合。
 * @param {unknown} value URL 查询参数中的单页记录数，允许省略。
 * @returns {number} 介于 1 与 MAX_MEMBER_PAGE_SIZE 之间的整数。
 * @throws {import("../lib/http-error").HttpError} 数量格式错误或超出范围时抛出 400。
 */
function normalizeMemberPageSize(value) {
  if (value === undefined || value === null || value === "") return 10;
  const pageSize = Number(value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_MEMBER_PAGE_SIZE) {
    throw badRequest(`成员每页数量必须是 1 到 ${MAX_MEMBER_PAGE_SIZE} 之间的整数`);
  }
  return pageSize;
}

/**
 * 规范化成员组织范围筛选开关，兼容 URL 查询参数的字符串布尔值。
 * @param {unknown} value URL 查询参数中的 includeDescendants 值；省略时按 false 处理。
 * @returns {boolean} 是否包含当前组织的全部后代节点。
 * @throws {import("../lib/http-error").HttpError} 值不是布尔值或 true/false 字符串时抛出 400。
 */
function normalizeMemberBoolean(value) {
  if (value === undefined || value === null || value === "") return false;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw badRequest("成员组织范围开关必须是布尔值");
}

/**
 * 确认当前会话为 Company 的系统管理员。组织树和账号范围是平台安全边界，不能由子管理员修改。
 * @param {{isAdmin?: boolean}} auth authenticate 中间件提供的可信认证上下文。
 * @returns {void} 系统管理员时正常返回。
 * @throws {import("../lib/http-error").HttpError} 非系统管理员时抛出 403。
 */
function assertSystemAdministrator(auth) {
  if (!auth?.isAdmin) throw forbidden("仅系统管理员可以维护组织与成员范围");
}

/**
 * 向已有或新建 Parse Schema 补齐缺失字段；不会删除、重命名或覆盖业务方已有字段。
 * @param {string} className 需要补齐字段的 Parse 类名。
 * @param {Array<{name: string, type: string, options?: Record<string, unknown>}>} fields 平台维护字段定义。
 * @param {boolean} privateOnCreate 新建类时是否应用私有 CLP；既有类不会被本函数重置权限。
 * @returns {Promise<{created: boolean, fields: string[]}>} 新建状态与本次实际补齐字段名。
 * @throws {Error} Parse Schema 查询或更新失败时向调用者抛出。
 */
async function ensureSchemaFields(className, fields, privateOnCreate) {
  const schemas = await Parse.Schema.all(master);
  const definition = schemas.find((schema) => schema.className === className);
  const existingFields = definition?.fields || {};
  const missingFields = fields.filter((field) => !existingFields[field.name]);
  if (definition && !missingFields.length) return { created: false, fields: [] };

  const schema = new Parse.Schema(className);
  for (const field of definition ? missingFields : fields) {
    schema.addField(field.name, field.type, field.options || {});
  }
  if (!definition && privateOnCreate) schema.setCLP(new Parse.CLP());
  if (definition) await schema.update(master);
  else await schema.save(master);
  return { created: !definition, fields: (definition ? missingFields : fields).map((field) => field.name) };
}

/**
 * 确保组织树、成员关联组织、账号组织范围和个人主题偏好字段在旧部署中可用。该操作仅追加平台字段，具备幂等性。
 * @returns {Promise<{organization: {created: boolean, fields: string[]}, user: {created: boolean, fields: string[]}}>} Schema 补齐结果。
 * @throws {Error} Parse Schema 操作失败时抛出，调用方将通过统一错误中间件返回 500。
 */
async function ensureOrganizationInfrastructure() {
  const organization = await ensureSchemaFields(
    ORGANIZATION_CLASS,
    [
      { name: "company", type: "Pointer", options: { targetClass: "Company" } },
      { name: "parent", type: "Pointer", options: { targetClass: ORGANIZATION_CLASS } },
      { name: "name", type: "String", options: { required: true } },
      { name: "code", type: "String" },
      { name: "type", type: "String" },
      { name: "rank", type: "Number" },
      { name: "isActive", type: "Boolean" },
      { name: "remark", type: "String" },
    ],
    true
  );
  const user = await ensureSchemaFields(
    "_User",
    [
      { name: "organization", type: "Pointer", options: { targetClass: ORGANIZATION_CLASS } },
      { name: "organizationIds", type: "Array" },
      { name: "organizationScopes", type: "Array" },
      { name: "organizationAdmin", type: "Boolean" },
      { name: "phone", type: "String" },
      { name: "frozenUntil", type: "Date" },
      { name: "systemOptions", type: "Object" },
    ],
    false
  );
  return { organization, user };
}

/**
 * 以分页方式加载一个 Company 的全部组织或成员配置，避免单次 Parse 查询超过服务端限制。
 * @param {string | typeof Parse.User} className 查询的 Parse 类名或 Parse.User 构造器。
 * @param {string} companyId 当前会话所属 Company 的 objectId。
 * @param {string[]} [include=[]] 需要 include 的 Pointer/数组 Pointer 字段。
 * @returns {Promise<Parse.Object[]>} 最多 MAX_CONFIGURATION_RECORDS 条同租户记录，按创建顺序拼接。
 * @throws {import("../lib/http-error").HttpError} 配置记录数量超过安全上限时抛出 400。
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
  throw badRequest("组织或成员配置数量超过当前安全加载上限，请联系系统管理员分批处理");
}

/**
 * 将 Organization Parse 记录转换为前端安全 DTO，不暴露 ACL、Company 指针等无关内部字段。
 * @param {Parse.Object} record 已按当前 Company 范围查询到的组织记录。
 * @returns {{objectId: string, parentId: string | null, name: string, code: string, type: string, rank: number, isActive: boolean, remark: string}} 可用于组织树和表单的对象。
 */
function organizationDto(record) {
  return {
    objectId: record.id,
    parentId: pointerId(record.get("parent")),
    name: record.get("name") || "未命名组织",
    code: record.get("code") || "",
    type: record.get("type") || "other",
    rank: Number(record.get("rank")) || 0,
    isActive: record.get("isActive") !== false,
    remark: record.get("remark") || "",
  };
}

/**
 * 将 _User Parse 记录转换为组织成员管理页所需的脱敏 DTO；绝不包含密码、会话令牌或 ACL。
 * @param {Parse.Object} user 已按当前 Company 范围查询并包含关联字段的用户记录。
 * @returns {{objectId: string, username: string, name: string, nickname: string, email: string, roleId: string | null, organizationId: string | null, organizationIds: string[], scopeIds: string[], organizationAdmin: boolean, isDelete: boolean}} 成员安全 DTO。
 */
function memberDto(user) {
  const legacyOrganizationId = pointerId(user.get("organization"));
  const configuredOrganizationIds = (user.get("organizationIds") || []).map(pointerId).filter(Boolean);
  const organizationIds = configuredOrganizationIds.length
    ? [...new Set(configuredOrganizationIds)]
    : legacyOrganizationId
      ? [legacyOrganizationId]
      : [];
  return {
    objectId: user.id,
    username: user.get("username") || "",
    name: user.get("name") || "",
    nickname: user.get("nickname") || "",
    email: user.get("email") || "",
    phone: user.get("phone") || user.get("mobilePhone") || "",
    roleId: pointerId(user.get("role")),
    // 保留主组织字段用于兼容历史业务；新页面统一消费 organizationIds 多组织关联。
    organizationId: legacyOrganizationId || organizationIds[0] || null,
    organizationIds,
    scopeIds: (user.get("organizationScopes") || []).map(pointerId).filter(Boolean),
    organizationAdmin: user.get("organizationAdmin") === true,
    isDelete: user.get("isDelete") === true,
  };
}

/**
 * 将平铺的组织节点组装为稳定排序的树，孤儿节点安全降级为根节点，避免异常历史数据导致页面白屏。
 * @param {Parse.Object[]} records 当前 Company 内的 Organization 记录。
 * @returns {Array<Record<string, unknown>>} 含 children 数组的组织树节点。
 */
function buildOrganizationTree(records) {
  const nodes = records.map((record) => ({ ...organizationDto(record), children: [] }));
  const nodeById = new Map(nodes.map((node) => [node.objectId, node]));
  const roots = [];

  for (const node of nodes) {
    const parent = node.parentId ? nodeById.get(node.parentId) : null;
    if (parent && parent.objectId !== node.objectId) parent.children.push(node);
    else roots.push(node);
  }

  /**
   * 递归按排序值、名称和 objectId 固定组织树顺序，确保不同浏览器展示一致。
   * @param {Array<Record<string, unknown>>} items 同一层级的组织节点数组。
   * @returns {void} 原地排序并继续处理 children。
   */
  const sortNodes = (items) => {
    items.sort((left, right) =>
      Number(left.rank) - Number(right.rank) ||
      String(left.name).localeCompare(String(right.name), "zh-CN") ||
      String(left.objectId).localeCompare(String(right.objectId))
    );
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

/**
 * 查询当前 Company 中一个确定存在的组织节点，永远不接受客户端 Company ID。
 * @param {{companyId: string}} auth authenticate 中间件提供的可信认证上下文。
 * @param {string} organizationId 需要查询的组织 objectId。
 * @returns {Promise<Parse.Object>} 同租户组织记录。
 * @throws {import("../lib/http-error").HttpError} 节点不存在或不属于当前 Company 时抛出 404。
 */
async function getTenantOrganization(auth, organizationId) {
  const query = new Parse.Query(ORGANIZATION_CLASS);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.equalTo("objectId", organizationId);
  const record = await query.first(master);
  if (!record) throw notFound("组织不存在或不属于当前企业");
  return record;
}

/**
 * 规范化组织节点的创建或编辑输入。
 * @param {Record<string, unknown> | undefined} input HTTP 请求体。
 * @param {boolean} editing 是否为编辑场景；编辑时未传字段保持 undefined，不覆盖旧值。
 * @returns {{name?: string, code?: string, type?: string, parentId?: string | null, rank?: number, remark?: string, isActive?: boolean}} 已校验字段。
 * @throws {import("../lib/http-error").HttpError} 输入不符合组织数据规则时抛出 400。
 */
function normalizeOrganizationInput(input, editing) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("组织配置必须是对象");
  const result = {};
  if (!editing || Object.prototype.hasOwnProperty.call(input, "name")) {
    result.name = requiredText(input.name, "组织名称", 100);
  }
  if (!editing || Object.prototype.hasOwnProperty.call(input, "code")) {
    result.code = optionalText(input.code, "组织编码", 64) || "";
  }
  if (!editing || Object.prototype.hasOwnProperty.call(input, "type")) {
    const type = input.type || "other";
    if (typeof type !== "string" || !ORGANIZATION_TYPES.has(type)) throw badRequest("组织类型无效");
    result.type = type;
  }
  if (!editing || Object.prototype.hasOwnProperty.call(input, "parentId")) {
    result.parentId = normalizeObjectId(input.parentId, "上级组织", false);
  }
  if (!editing || Object.prototype.hasOwnProperty.call(input, "rank")) {
    result.rank = normalizeRank(input.rank);
  }
  if (!editing || Object.prototype.hasOwnProperty.call(input, "remark")) {
    result.remark = optionalText(input.remark, "备注", 500) || "";
  }
  if (editing && Object.prototype.hasOwnProperty.call(input, "isActive")) {
    if (typeof input.isActive !== "boolean") throw badRequest("启用状态必须是布尔值");
    result.isActive = input.isActive;
  }
  return result;
}

/**
 * 验证待写入的组织编码在当前 Company 内唯一；空编码可重复，便于只使用名称的轻量级组织树。
 * @param {{companyId: string}} auth 可信认证上下文。
 * @param {string} code 待校验组织编码。
 * @param {string | undefined} excludedId 编辑时需要排除的当前组织 objectId。
 * @returns {Promise<void>} 无冲突时兑现。
 * @throws {import("../lib/http-error").HttpError} 编码已被同租户其他节点使用时抛出 400。
 */
async function assertUniqueOrganizationCode(auth, code, excludedId) {
  if (!code) return;
  const query = new Parse.Query(ORGANIZATION_CLASS);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.equalTo("code", code);
  const found = await query.first(master);
  if (found && found.id !== excludedId) throw badRequest("该组织编码已存在");
}

/**
 * 判断指定 parentId 是否是当前组织的后代，防止拖拽或编辑时形成循环树。
 * @param {{companyId: string}} auth 可信认证上下文。
 * @param {string} organizationId 正在编辑的组织 objectId。
 * @param {string | null | undefined} parentId 待设置的上级组织 objectId。
 * @returns {Promise<void>} 父节点合法时兑现。
 * @throws {import("../lib/http-error").HttpError} 父节点不存在、等于自身或属于后代时抛出 400。
 */
async function assertValidParent(auth, organizationId, parentId) {
  if (!parentId) return;
  if (organizationId === parentId) throw badRequest("组织不能设置自己为上级");
  await getTenantOrganization(auth, parentId);
  const records = await listTenantRecords(ORGANIZATION_CLASS, auth.companyId, ["parent"]);
  const childrenByParent = new Map();
  for (const record of records) {
    const currentParentId = pointerId(record.get("parent"));
    if (!currentParentId) continue;
    const children = childrenByParent.get(currentParentId) || [];
    children.push(record.id);
    childrenByParent.set(currentParentId, children);
  }
  const pending = [...(childrenByParent.get(organizationId) || [])];
  const visited = new Set();
  while (pending.length) {
    const childId = pending.shift();
    if (!childId || visited.has(childId)) continue;
    if (childId === parentId) throw badRequest("不能将组织移动到自己的下级节点");
    visited.add(childId);
    pending.push(...(childrenByParent.get(childId) || []));
  }
}

/**
 * 确认待删除组织没有被任意业务表的 Organization Pointer 字段引用。成员主组织与范围数组由
 * deleteOrganization 单独检查；这里覆盖低代码业务表，避免删除后产生无法定位、无法授权的历史记录。
 * @param {string} organizationId 已完成租户校验的待删除组织 objectId。
 * @returns {Promise<void>} 未发现引用时兑现。
 * @throws {import("../lib/http-error").HttpError} 任意业务字段仍指向该组织时抛出 400，拒绝破坏引用完整性。
 */
async function assertNoBusinessOrganizationReferences(organizationId) {
  const schemas = await Parse.Schema.all(master);
  const organizationPointer = pointer(ORGANIZATION_CLASS, organizationId);
  const references = [];

  for (const schema of schemas) {
    const className = schema.className;
    if (!className || className === ORGANIZATION_CLASS || className === "_User") continue;
    const fields = schema.fields || {};
    const organizationFields = Object.entries(fields).filter(
      ([, definition]) => definition?.type === "Pointer" && definition.targetClass === ORGANIZATION_CLASS
    );

    for (const [fieldName] of organizationFields) {
      const query = new Parse.Query(className);
      query.equalTo(fieldName, organizationPointer);
      query.limit(1);
      if (await query.first(master)) {
        references.push(`${className}.${fieldName}`);
        if (references.length >= 5) break;
      }
    }
    if (references.length >= 5) break;
  }

  if (references.length) {
    throw badRequest(`该组织仍被业务数据引用（${references.join("、")}），不能删除`);
  }
}

/**
 * 获取系统管理员所需的组织树、角色和成员配置，用于一屏完成组织与账号范围维护。
 * @param {{companyId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @returns {Promise<{tree: Array<Record<string, unknown>>, organizations: Array<Record<string, unknown>>, roles: Array<Record<string, unknown>>}>} 组织管理页面初始数据；成员由分页接口单独返回。
 * @throws {import("../lib/http-error").HttpError} 非系统管理员访问时抛出 403。
 */
async function getOrganizationOverview(auth) {
  assertSystemAdministrator(auth);
  await ensureOrganizationInfrastructure();
  const [organizations, roles] = await Promise.all([
    listTenantRecords(ORGANIZATION_CLASS, auth.companyId, ["parent"]),
    listTenantRecords("Role", auth.companyId),
  ]);
  const organizationDtos = organizations.map(organizationDto);
  return {
    tree: buildOrganizationTree(organizations),
    organizations: organizationDtos,
    roles: roles
      // 系统角色只由平台初始化和 Company.admin 维护，不能经成员表单下放给普通账号。
      .filter((role) => !String(role.get("systemKey") || "").trim())
      .map((role) => ({ objectId: role.id, name: role.get("name") || "未命名角色" }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
  };
}

/**
 * 分页读取当前 Company 的成员配置。成员列表不复用组织概览的全量加载，避免大型企业因浏览器内存或
 * 服务端配置上限无法维护第 10,001 名及之后的员工。
 * @param {{companyId: string, isAdmin?: boolean}} auth authenticate 中间件提供的可信认证上下文。
 * @param {{page?: unknown, pageSize?: unknown, keyword?: unknown} | undefined} input URL 查询参数；keyword 仅按账号包含检索。
 * @returns {Promise<{members: Array<Record<string, unknown>>, count: number, page: number, pageSize: number}>} 当前页成员 DTO 与总数。
 * @throws {import("../lib/http-error").HttpError} 非系统管理员、页码或检索词无效时抛出 400/403。
 */
async function listOrganizationMembers(auth, input = {}) {
  assertSystemAdministrator(auth);
  await ensureOrganizationInfrastructure();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("成员查询参数必须是对象");

  const page = normalizeMemberPage(input.page);
  const pageSize = normalizeMemberPageSize(input.pageSize);
  const keyword = optionalText(input.keyword, "成员账号检索词", 64);
  const organizationId = normalizeObjectId(input.organizationId, "组织标识", false);
  const includeDescendants = normalizeMemberBoolean(input.includeDescendants);
  const organizationIds = organizationId
    ? await resolveOrganizationFilterIds(auth, organizationId, includeDescendants)
    : [];
  const configureQuery = (query) => {
    query.equalTo("company", pointer("Company", auth.companyId));
    if (keyword) query.contains("username", keyword);
  };
  const buildMemberQuery = () => {
    if (!organizationIds.length) {
      const query = new Parse.Query(Parse.User);
      configureQuery(query);
      return query;
    }
    const pointers = organizationIds.map((id) => pointer(ORGANIZATION_CLASS, id));
    const primaryQuery = new Parse.Query(Parse.User);
    const associatedQuery = new Parse.Query(Parse.User);
    configureQuery(primaryQuery);
    configureQuery(associatedQuery);
    primaryQuery.containedIn("organization", pointers);
    associatedQuery.containedIn("organizationIds", pointers);
    return Parse.Query.or(primaryQuery, associatedQuery);
  };
  const recordsQuery = buildMemberQuery();
  const countQuery = buildMemberQuery();
  recordsQuery.include(["role", "organization", "organizationIds", "organizationScopes"]);
  recordsQuery.descending("createdAt");
  recordsQuery.limit(pageSize);
  recordsQuery.skip((page - 1) * pageSize);

  const [records, count] = await Promise.all([recordsQuery.find(master), countQuery.count(master)]);
  return {
    members: records.map(memberDto),
    count,
    page,
    pageSize,
    organizationId,
    includeDescendants,
  };
}

/**
 * 解析成员列表的组织筛选范围；当前组织本身始终包含，后代模式通过服务端组织树递归展开。
 * @param {{companyId: string}} auth 当前请求的可信企业认证上下文。
 * @param {string} organizationId 作为筛选根节点的组织 objectId。
 * @param {boolean} includeDescendants 是否包含全部后代组织。
 * @returns {Promise<string[]>} 可用于 Parse containedIn 的同租户组织 objectId 集合。
 * @throws {import("../lib/http-error").HttpError} 组织不存在、跨租户或组织树读取失败时抛出。
 */
async function resolveOrganizationFilterIds(auth, organizationId, includeDescendants) {
  await getTenantOrganization(auth, organizationId);
  if (!includeDescendants) return [organizationId];

  const records = await listTenantRecords(ORGANIZATION_CLASS, auth.companyId, ["parent"]);
  const childrenByParent = new Map();
  for (const record of records) {
    const parentId = pointerId(record.get("parent"));
    if (!parentId || record.get("isActive") === false) continue;
    const children = childrenByParent.get(parentId) || [];
    children.push(record.id);
    childrenByParent.set(parentId, children);
  }

  const result = [];
  const visited = new Set();
  const pending = [organizationId];
  while (pending.length) {
    const currentId = pending.shift();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    result.push(currentId);
    pending.push(...(childrenByParent.get(currentId) || []));
  }
  return result;
}

/**
 * 创建当前 Company 下的组织节点并可选关联上级节点。
 * @param {{companyId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {Record<string, unknown>} input 组织表单数据，包含 name、code、type、parentId、rank 与 remark。
 * @returns {Promise<Record<string, unknown>>} 新建组织的安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 权限、父节点或输入无效时抛出 400/403/404。
 */
async function createOrganization(auth, input) {
  assertSystemAdministrator(auth);
  await ensureOrganizationInfrastructure();
  const normalized = normalizeOrganizationInput(input, false);
  if (normalized.parentId) await getTenantOrganization(auth, normalized.parentId);
  await assertUniqueOrganizationCode(auth, normalized.code);
  const Organization = Parse.Object.extend(ORGANIZATION_CLASS);
  const organization = new Organization();
  organization.set("company", pointer("Company", auth.companyId));
  organization.set("name", normalized.name);
  organization.set("code", normalized.code);
  organization.set("type", normalized.type);
  organization.set("rank", normalized.rank);
  organization.set("remark", normalized.remark);
  organization.set("isActive", true);
  if (normalized.parentId) organization.set("parent", pointer(ORGANIZATION_CLASS, normalized.parentId));
  await organization.save(null, master);
  return organizationDto(organization);
}

/**
 * 更新当前 Company 下的组织节点；移动节点时强制检查循环关系与上级租户归属。
 * @param {{companyId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {string} organizationId 需要修改的组织 objectId。
 * @param {Record<string, unknown>} input 组织编辑表单数据。
 * @returns {Promise<Record<string, unknown>>} 更新后组织的安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 非管理员、节点不存在或输入非法时抛出对应 HTTP 错误。
 */
async function updateOrganization(auth, organizationId, input) {
  assertSystemAdministrator(auth);
  await ensureOrganizationInfrastructure();
  const id = normalizeObjectId(organizationId, "组织标识");
  const organization = await getTenantOrganization(auth, id);
  const normalized = normalizeOrganizationInput(input, true);
  const effectiveCode = normalized.code === undefined ? organization.get("code") || "" : normalized.code;
  await assertUniqueOrganizationCode(auth, effectiveCode, organization.id);
  if (normalized.parentId !== undefined) await assertValidParent(auth, organization.id, normalized.parentId);

  if (normalized.name !== undefined) organization.set("name", normalized.name);
  if (normalized.code !== undefined) organization.set("code", normalized.code);
  if (normalized.type !== undefined) organization.set("type", normalized.type);
  if (normalized.rank !== undefined) organization.set("rank", normalized.rank);
  if (normalized.remark !== undefined) organization.set("remark", normalized.remark);
  if (normalized.isActive !== undefined) organization.set("isActive", normalized.isActive);
  if (normalized.parentId !== undefined) organization.set("parent", normalized.parentId ? pointer(ORGANIZATION_CLASS, normalized.parentId) : null);
  await organization.save(null, master);
  return organizationDto(organization);
}

/**
 * 删除没有子节点且未被成员引用的空组织，避免破坏现有组织范围与历史业务归属。
 * @param {{companyId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {string} organizationId 需要删除的组织 objectId。
 * @returns {Promise<void>} 删除成功后兑现。
 * @throws {import("../lib/http-error").HttpError} 组织仍有子节点、成员主组织或管理范围引用时抛出 400。
 */
async function deleteOrganization(auth, organizationId) {
  assertSystemAdministrator(auth);
  await ensureOrganizationInfrastructure();
  const id = normalizeObjectId(organizationId, "组织标识");
  const organization = await getTenantOrganization(auth, id);
  const [organizations, users] = await Promise.all([
    listTenantRecords(ORGANIZATION_CLASS, auth.companyId, ["parent"]),
    listTenantRecords(Parse.User, auth.companyId, ["organization", "organizationIds", "organizationScopes"]),
  ]);
  if (organizations.some((item) => pointerId(item.get("parent")) === id)) {
    throw badRequest("请先处理该组织的下级节点，再删除当前组织");
  }
  const referenced = users.some((user) =>
    pointerId(user.get("organization")) === id ||
    (user.get("organizationIds") || []).some((organization) => pointerId(organization) === id) ||
    (user.get("organizationScopes") || []).some((scope) => pointerId(scope) === id)
  );
  if (referenced) throw badRequest("该组织仍被成员关联组织或组织数据权限引用，不能删除");
  await assertNoBusinessOrganizationReferences(id);
  await organization.destroy(master);
}

/**
 * 校验角色属于当前 Company；成员角色永远不能引用其他租户的 Role。
 * @param {{companyId: string}} auth 可信认证上下文。
 * @param {unknown} roleId 来自成员表单的角色 objectId，可为空。
 * @returns {Promise<{__type: "Pointer", className: string, objectId: string} | null>} 可安全写入用户记录的 Role Pointer。
 * @throws {import("../lib/http-error").HttpError} 角色不存在或跨租户时抛出 400。
 */
async function validateRolePointer(auth, roleId) {
  const id = normalizeObjectId(roleId, "角色", false);
  if (!id) return null;
  const query = new Parse.Query("Role");
  query.equalTo("company", pointer("Company", auth.companyId));
  query.equalTo("objectId", id);
  const role = await query.first(master);
  if (!role || String(role.get("systemKey") || "").trim()) {
    throw badRequest("所选岗位不存在、已受系统保护或不属于当前企业");
  }
  return pointer("Role", id);
}

/**
 * 校验成员关联组织和组织数据权限均属于当前 Company。历史主组织字段继续保存为首个关联组织，
 * 以兼容已有业务表与旧版本页面；新配置不再把组织关联限制为单个节点。
 * @param {{companyId: string}} auth 可信认证上下文。
 * @param {unknown} organizationIds 成员关联组织 objectId 数组；为兼容旧接口也允许单个 objectId。
 * @param {unknown} scopeIds 成员拥有数据权限的组织 objectId 数组。
 * @returns {Promise<{organization: {__type: "Pointer", className: string, objectId: string}, organizations: Array<{__type: "Pointer", className: string, objectId: string}>, scopes: Array<{__type: "Pointer", className: string, objectId: string}>}>} 已验证的 Pointer 集合。
 * @throws {import("../lib/http-error").HttpError} 关联组织或权限范围为空、超限或包含跨租户节点时抛出 400。
 */
async function validateOrganizationAssignment(auth, organizationIds, scopeIds) {
  const rawOrganizationIds = Array.isArray(organizationIds) ? organizationIds : [organizationIds];
  if (!rawOrganizationIds.length) throw badRequest("请至少关联一个组织");
  if (rawOrganizationIds.length > 100) throw badRequest("单个成员最多可关联 100 个组织");
  if (!Array.isArray(scopeIds)) throw badRequest("组织数据权限必须是数组");
  if (!scopeIds.length) throw badRequest("请至少配置一个组织数据权限");
  if (scopeIds.length > 100) throw badRequest("单个成员最多可配置 100 个组织数据权限");
  const normalizedOrganizationIds = [...new Set(rawOrganizationIds.map((value) => normalizeObjectId(value, "关联组织")))];
  const normalizedScopeIds = [...new Set(scopeIds.map((value) => normalizeObjectId(value, "组织数据权限")))];
  const organizations = await listTenantRecords(ORGANIZATION_CLASS, auth.companyId);
  const validIds = new Set(organizations.filter((item) => item.get("isActive") !== false).map((item) => item.id));
  if (normalizedOrganizationIds.some((id) => !validIds.has(id)) || normalizedScopeIds.some((id) => !validIds.has(id))) {
    throw badRequest("关联组织或组织数据权限包含无效、停用或跨企业节点");
  }
  return {
    // legacy organization 始终指向第一个关联组织，保证旧的组织筛选和归属字段继续可用。
    organization: pointer(ORGANIZATION_CLASS, normalizedOrganizationIds[0]),
    organizations: normalizedOrganizationIds.map((id) => pointer(ORGANIZATION_CLASS, id)),
    scopes: normalizedScopeIds.map((id) => pointer(ORGANIZATION_CLASS, id)),
  };
}

/**
 * 创建子管理员或普通成员账号。密码仅在本次注册请求中使用，绝不写入响应或日志。
 * @param {{companyId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {Record<string, unknown>} input 成员表单，含 username、password、roleId、organizationIds、scopeIds 等字段。
 * @returns {Promise<Record<string, unknown>>} 新建成员的安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 用户名、密码、角色或组织范围非法时抛出 400/403。
 */
async function createOrganizationMember(auth, input) {
  assertSystemAdministrator(auth);
  await ensureOrganizationInfrastructure();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("成员配置必须是对象");
  const username = requiredText(input.username, "账号", 64);
  const password = requiredText(input.password, "密码", 256);
  if (password.length < 12) throw badRequest("密码长度不能少于 12 个字符");
  const [role, assignment] = await Promise.all([
    validateRolePointer(auth, input.roleId),
    validateOrganizationAssignment(auth, input.organizationIds ?? input.organizationId, input.scopeIds || []),
  ]);
  const existingQuery = new Parse.Query(Parse.User);
  existingQuery.equalTo("username", username);
  if (await existingQuery.first(master)) throw badRequest("该账号已存在");

  const user = new Parse.User();
  user.set("username", username);
  user.set("password", password);
  user.set("company", pointer("Company", auth.companyId));
  user.set("organization", assignment.organization);
  user.set("organizationIds", assignment.organizations);
  user.set("organizationScopes", assignment.scopes);
  user.set("organizationAdmin", input.organizationAdmin === true);
  user.set("isDelete", false);
  if (role) user.set("role", role);
  const name = optionalText(input.name, "姓名", 100);
  const nickname = optionalText(input.nickname, "昵称", 100);
  const email = optionalText(input.email, "邮箱", 254);
  if (name) user.set("name", name);
  if (nickname) user.set("nickname", nickname);
  if (email) user.set("email", email);
  await user.signUp(null, master);
  return {
    objectId: user.id,
    username,
    name: user.get("name") || "",
    nickname: user.get("nickname") || "",
    email: user.get("email") || "",
    roleId: pointerId(user.get("role")),
    organizationId: pointerId(user.get("organization")),
    organizationIds: assignment.organizations.map(pointerId),
    scopeIds: assignment.scopes.map(pointerId),
    organizationAdmin: user.get("organizationAdmin") === true,
    isDelete: false,
  };
}

/**
 * 更新当前 Company 成员的岗位、关联组织、组织数据权限、基本资料、状态或密码；不能通过该接口删除当前操作者自己。
 * @param {{companyId: string, userId: string, isAdmin?: boolean}} auth 可信认证上下文。
 * @param {string} userId 需要更新的成员 objectId。
 * @param {Record<string, unknown>} input 成员编辑表单，未提供的字段保持原值。
 * @returns {Promise<Record<string, unknown>>} 更新后成员的安全 DTO。
 * @throws {import("../lib/http-error").HttpError} 非管理员、跨租户成员或不合法资料时抛出对应 HTTP 错误。
 */
async function updateOrganizationMember(auth, userId, input) {
  assertSystemAdministrator(auth);
  await ensureOrganizationInfrastructure();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("成员配置必须是对象");
  const id = normalizeObjectId(userId, "成员标识");
  const query = new Parse.Query(Parse.User);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.equalTo("objectId", id);
  query.include(["organization", "organizationIds", "organizationScopes", "role"]);
  const user = await query.first(master);
  if (!user) throw notFound("成员不存在或不属于当前企业");
  if (id === auth.userId && input.isDelete === true) throw badRequest("不能停用当前登录账号");

  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const existingOrganizationIds = (user.get("organizationIds") || []).map(pointerId).filter(Boolean);
  const effectiveOrganizationIds = has("organizationIds")
    ? input.organizationIds
    : has("organizationId")
      ? input.organizationId
      : existingOrganizationIds.length
        ? existingOrganizationIds
        : pointerId(user.get("organization"));
  const effectiveScopeIds = has("scopeIds") ? input.scopeIds : (user.get("organizationScopes") || []).map(pointerId).filter(Boolean);
  if (has("organizationId") || has("organizationIds") || has("scopeIds")) {
    const assignment = await validateOrganizationAssignment(auth, effectiveOrganizationIds, effectiveScopeIds);
    user.set("organization", assignment.organization);
    user.set("organizationIds", assignment.organizations);
    user.set("organizationScopes", assignment.scopes);
  }
  if (has("roleId")) {
    const role = await validateRolePointer(auth, input.roleId);
    user.set("role", role);
  }
  if (has("organizationAdmin")) {
    if (typeof input.organizationAdmin !== "boolean") throw badRequest("子管理员标记必须是布尔值");
    user.set("organizationAdmin", input.organizationAdmin);
  }
  if (has("isDelete")) {
    if (typeof input.isDelete !== "boolean") throw badRequest("账号状态必须是布尔值");
    user.set("isDelete", input.isDelete);
  }
  if (has("name")) user.set("name", optionalText(input.name, "姓名", 100) || "");
  if (has("nickname")) user.set("nickname", optionalText(input.nickname, "昵称", 100) || "");
  if (has("email")) user.set("email", optionalText(input.email, "邮箱", 254) || "");
  if (has("password")) {
    const password = requiredText(input.password, "密码", 256);
    if (password.length < 12) throw badRequest("密码长度不能少于 12 个字符");
    user.set("password", password);
  }
  await user.save(null, master);
  return {
    objectId: user.id,
    username: user.get("username") || "",
    name: user.get("name") || "",
    nickname: user.get("nickname") || "",
    email: user.get("email") || "",
    roleId: pointerId(user.get("role")),
    organizationId: pointerId(user.get("organization")),
    organizationIds: (user.get("organizationIds") || []).map(pointerId).filter(Boolean),
    scopeIds: (user.get("organizationScopes") || []).map(pointerId).filter(Boolean),
    organizationAdmin: user.get("organizationAdmin") === true,
    isDelete: user.get("isDelete") === true,
  };
}

/**
 * 解析普通成员可以管理的组织及其全部下级组织。系统管理员返回 null 表示无需额外组织过滤。
 * @param {{companyId: string, isAdmin?: boolean, user?: Parse.Object}} auth 可信认证上下文。
 * @returns {Promise<string[] | null>} 非管理员返回可访问组织 objectId 集合；无有效范围返回空数组；系统管理员返回 null。
 * @throws {Error} 组织树读取失败时抛出，调用方应中止请求而不是放宽数据权限。
 */
async function resolveAccessibleOrganizationIds(auth) {
  if (auth?.isAdmin) return null;
  const user = auth?.user;
  const configuredScopeIds = (user?.get("organizationScopes") || []).map(pointerId).filter(Boolean);
  const associatedOrganizationIds = (user?.get("organizationIds") || []).map(pointerId).filter(Boolean);
  const primaryOrganizationId = pointerId(user?.get("organization"));
  const rootIds = configuredScopeIds.length
    ? configuredScopeIds
    : associatedOrganizationIds.length
      ? associatedOrganizationIds
      : primaryOrganizationId
        ? [primaryOrganizationId]
        : [];
  if (!rootIds.length) return [];

  const records = await listTenantRecords(ORGANIZATION_CLASS, auth.companyId, ["parent"]);
  const activeIds = new Set(records.filter((record) => record.get("isActive") !== false).map((record) => record.id));
  const childrenByParent = new Map();
  for (const record of records) {
    if (record.get("isActive") === false) continue;
    const parentId = pointerId(record.get("parent"));
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) || [];
    children.push(record.id);
    childrenByParent.set(parentId, children);
  }

  const pending = rootIds.filter((id) => activeIds.has(id));
  const accessibleIds = new Set();
  while (pending.length) {
    const currentId = pending.shift();
    if (!currentId || accessibleIds.has(currentId)) continue;
    accessibleIds.add(currentId);
    pending.push(...(childrenByParent.get(currentId) || []));
  }
  return [...accessibleIds];
}

/**
 * 判断一个组织是否在当前普通成员的授权范围内；系统管理员始终允许。
 * @param {{companyId: string, isAdmin?: boolean, user?: Parse.Object}} auth 可信认证上下文。
 * @param {string} organizationId 待检查组织 objectId。
 * @returns {Promise<boolean>} 当前成员可管理该组织或其上级范围覆盖该组织时返回 true。
 */
async function canManageOrganization(auth, organizationId) {
  const accessibleIds = await resolveAccessibleOrganizationIds(auth);
  return accessibleIds === null || accessibleIds.includes(organizationId);
}

module.exports = {
  ORGANIZATION_CLASS,
  ensureOrganizationInfrastructure,
  getOrganizationOverview,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  createOrganizationMember,
  updateOrganizationMember,
  listOrganizationMembers,
  resolveAccessibleOrganizationIds,
  canManageOrganization,
};
