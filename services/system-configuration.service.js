"use strict";

const Parse = require("parse/node");
const { forbidden } = require("../lib/http-error");
const { initializeParse } = require("./parse-runtime");
const { clearSchemaCache } = require("./parse-data.service");
const { ensureOrganizationInfrastructure, ORGANIZATION_CLASS } = require("./organization.service");
const { ensurePositionInfrastructure } = require("./position.service");

initializeParse();

/** 仅由后端系统配置修复流程使用的 Master Key 选项。 */
const master = { useMasterKey: true };

/**
 * 将 Parse 对象转换为 Pointer JSON，避免初始化流程意外依赖浏览器端 Parse 适配行为。
 * @param {Parse.Object} record 已保存的 Parse 记录。
 * @returns {{__type: "Pointer", className: string, objectId: string}} 指向该记录的安全 Pointer。
 */
function pointer(record) {
  return { __type: "Pointer", className: record.className, objectId: record.id };
}

/**
 * 从 Parse Pointer、Parse Object 或序列化对象中读取 objectId。
 * @param {unknown} value 任意关联字段值。
 * @returns {string | null} 关联记录标识；不存在时返回 null。
 */
function pointerId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || value.objectId || null;
}

/**
 * 限制系统配置自修复只能由 Company 系统管理员触发，防止普通角色借此创建隐藏菜单或元数据。
 * @param {{isAdmin?: boolean}} auth authenticate 中间件提供的可信认证上下文。
 * @returns {void} 系统管理员时正常返回。
 * @throws {import("../lib/http-error").HttpError} 非系统管理员时抛出 403。
 */
function assertSystemAdministrator(auth) {
  if (!auth?.isAdmin) throw forbidden("仅系统管理员可以修复基础系统配置");
}

/**
 * 生成动态 CRUD 所需的组件选项默认值，使自动恢复的 Module/Route 表单与初始化脚本生成的表单一致。
 * @param {Record<string, unknown>} [overrides={}] 需要覆盖的组件选项。
 * @returns {Record<string, unknown>} 可保存到 Schema.fields 的组件配置。
 */
function componentOption(overrides = {}) {
  return {
    placeholder: "",
    disabled: false,
    allowClear: true,
    mode: "combobox",
    selectTable: undefined,
    labelKey: "name",
    valueKey: "objectId",
    ...overrides,
  };
}

/**
 * 构建 Schema 元数据的一个字段定义。该格式由前端 CommonPage、CommonForm 与 CommonTable 共同消费。
 * @param {string} type Parse 字段类型。
 * @param {string} chineseName 用户可见的中文字段名称。
 * @param {Record<string, unknown>} [options={}] 字段展示、筛选与关联配置。
 * @returns {Record<string, unknown>} 可写入 Schema.fields 的字段元数据。
 */
function uiField(type, chineseName, options = {}) {
  return {
    type,
    required: Boolean(options.required),
    chineseName,
    editComponent: options.editComponent || (type === "Boolean" ? "ASwitch" : type === "Number" ? "AInputNumber" : "AInput"),
    targetClass: options.targetClass,
    isFilter: Boolean(options.isFilter),
    isTable: Boolean(options.isTable),
    isPointer: Boolean(options.isPointer),
    isSole: Boolean(options.isSole),
    componentOption: componentOption(options.componentOption),
    ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }),
  };
}

/**
 * 返回所有系统元数据记录共享的只读字段配置。
 * @returns {Record<string, Record<string, unknown>>} objectId、company、createdAt、updatedAt 的 UI 元数据。
 */
function defaultMetadataFields() {
  return {
    objectId: uiField("String", "对象 ID", { editComponent: "AInput", componentOption: { disabled: true, allowClear: false } }),
    company: uiField("Pointer", "企业", {
      required: true,
      targetClass: "Company",
      isPointer: true,
      editComponent: "ASelect",
      componentOption: { selectTable: "Company", allowClear: false },
    }),
    createdAt: uiField("Date", "创建时间", { editComponent: "AInput", componentOption: { disabled: true, allowClear: false } }),
    updatedAt: uiField("Date", "更新时间", { editComponent: "AInput", componentOption: { disabled: true, allowClear: false } }),
  };
}

/**
 * 提供可恢复的 Module、Route 与 Organization Schema 元数据。字段只会补齐，不会覆盖管理员已定制的展示配置。
 * @returns {Array<{name: string, nickName: string, fields: Record<string, Record<string, unknown>>}>} 系统 Schema 元数据定义。
 */
function configurationMetadataDefinitions() {
  const base = defaultMetadataFields();
  return [
    {
      name: "Module",
      nickName: "模块",
      fields: {
        ...base,
        name: uiField("String", "名称", { required: true, isFilter: true, isTable: true }),
        path: uiField("String", "路径", { required: true, isTable: true }),
        rank: uiField("Number", "排序", { defaultValue: 0, isTable: true }),
        menu: uiField("Boolean", "显示菜单", { defaultValue: true, isTable: true }),
        icon: uiField("String", "图标", { isTable: true }),
        pageComponent: uiField("String", "页面组件"),
        targetClass: uiField("String", "目标表"),
        remark: uiField("String", "备注", { isTable: true }),
        routes: uiField("Array", "子路由", {
          targetClass: "Route",
          isPointer: true,
          editComponent: "ASelect",
          componentOption: { mode: "multiple", selectTable: "Route" },
        }),
      },
    },
    {
      name: "Route",
      nickName: "路由",
      fields: {
        ...base,
        name: uiField("String", "名称", { required: true, isFilter: true, isTable: true }),
        path: uiField("String", "路径", { required: true, isTable: true }),
        rank: uiField("Number", "排序", { defaultValue: 0, isTable: true }),
        menu: uiField("Boolean", "显示菜单", { defaultValue: true, isTable: true }),
        pageComponent: uiField("String", "页面组件", { isTable: true }),
        targetClass: uiField("String", "目标表", { isTable: true }),
        remark: uiField("String", "备注", { isTable: true }),
      },
    },
    {
      name: "Role",
      nickName: "岗位",
      fields: {
        ...base,
        name: uiField("String", "岗位名称", { required: true, isFilter: true, isTable: true }),
        module: uiField("Array", "可访问页面", {
          targetClass: "Module",
          isPointer: true,
          editComponent: "ASelect",
          componentOption: { mode: "multiple", selectTable: "Module" },
        }),
        positionManaged: uiField("Boolean", "由岗位管理维护", { defaultValue: false }),
      },
    },
    {
      name: "AllotPermission",
      nickName: "页面按钮权限",
      fields: {
        ...base,
        name: uiField("String", "权限名称", { isTable: true }),
        role: uiField("Pointer", "岗位", {
          targetClass: "Role",
          isPointer: true,
          editComponent: "ASelect",
          componentOption: { selectTable: "Role" },
        }),
        routes: uiField("Array", "页面", {
          targetClass: "Route",
          isPointer: true,
          editComponent: "ASelect",
          componentOption: { mode: "multiple", selectTable: "Route" },
        }),
        permissions: uiField("Array", "按钮权限", { editComponent: "ASelect", componentOption: { mode: "tags" } }),
        routePermissions: uiField("Object", "逐页按钮权限", { editComponent: "AInput" }),
        positionManaged: uiField("Boolean", "由岗位管理维护", { defaultValue: false }),
      },
    },
    {
      name: ORGANIZATION_CLASS,
      nickName: "组织架构",
      fields: {
        ...base,
        name: uiField("String", "组织名称", { required: true, isFilter: true, isTable: true }),
        code: uiField("String", "组织编码", { isFilter: true, isTable: true }),
        type: uiField("String", "组织类型", { isTable: true }),
        parent: uiField("Pointer", "上级组织", {
          targetClass: ORGANIZATION_CLASS,
          isPointer: true,
          editComponent: "ATreeSelect",
          componentOption: { selectTable: ORGANIZATION_CLASS },
        }),
        rank: uiField("Number", "排序", { defaultValue: 0, isTable: true }),
        isActive: uiField("Boolean", "启用", { defaultValue: true, isTable: true }),
        remark: uiField("String", "备注"),
      },
    },
  ];
}

/**
 * 在保留管理员已有字段配置与自定义字段的前提下，补齐系统 Schema 元数据中缺失的字段和组件选项。
 * 不能只比较字段数量：旧租户可能存在自定义字段，数量相同仍可能恰好缺少一个基础配置字段。
 * @param {Record<string, Record<string, unknown>>} defaultFields 系统定义的必备字段元数据，按字段名索引。
 * @param {unknown} currentFields 当前 Schema 记录中保存的字段元数据；异常值会安全按空对象处理。
 * @returns {{fields: Record<string, Record<string, unknown>>, changed: boolean}} 合并后的字段元数据与是否需要保存的标记。
 */
function mergeMissingMetadataFields(defaultFields, currentFields) {
  /**
   * 判断值是否为可安全展开的普通记录对象；数组、空值和标量都不能作为字段或组件配置使用。
   * @param {unknown} value 待判断的任意数据。
   * @returns {boolean} 值为非空、非数组对象时返回 true。
   */
  const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const existingFields = isRecord(currentFields) ? currentFields : {};
  const fields = { ...existingFields };
  let changed = existingFields !== currentFields;

  for (const [fieldName, defaultField] of Object.entries(defaultFields)) {
    const existingField = existingFields[fieldName];
    if (!isRecord(existingField)) {
      fields[fieldName] = defaultField;
      changed = true;
      continue;
    }

    const defaultOptions = isRecord(defaultField.componentOption) ? defaultField.componentOption : {};
    const existingOptions = isRecord(existingField.componentOption) ? existingField.componentOption : {};
    const missingFieldProperty = Object.entries(defaultField).some(
      ([key, value]) => key !== "componentOption" && value !== undefined && existingField[key] === undefined
    );
    const missingOptionProperty = Object.entries(defaultOptions).some(
      ([key, value]) => value !== undefined && existingOptions[key] === undefined
    );
    const invalidOptions = !isRecord(existingField.componentOption);

    if (missingFieldProperty || missingOptionProperty || invalidOptions) {
      fields[fieldName] = {
        ...defaultField,
        ...existingField,
        componentOption: { ...defaultOptions, ...existingOptions },
      };
      changed = true;
    }
  }

  return { fields, changed };
}

/**
 * 以 systemKey 为幂等键确保一条配置记录存在；现有记录只填补空字段，不覆盖管理员业务配置。
 * @param {string} className Parse 类名。
 * @param {string} systemKey 当前 Company 内唯一的系统配置键。
 * @param {Parse.Object} company 当前认证上下文所属的 Company 记录。
 * @param {Record<string, unknown>} attributes 缺失时应写入的属性。
 * @returns {Promise<{record: Parse.Object, created: boolean, changed: boolean}>} 最终记录及本次写入状态。
 * @throws {Error} Parse 查询或保存失败时向调用者抛出。
 */
async function ensureRecord(className, systemKey, company, attributes) {
  const query = new Parse.Query(className);
  query.equalTo("company", pointer(company));
  query.equalTo("systemKey", systemKey);
  let record = await query.first(master);
  const created = !record;
  if (!record) {
    const Record = Parse.Object.extend(className);
    record = new Record();
    record.set("company", pointer(company));
    record.set("systemKey", systemKey);
  }
  let changed = created;
  for (const [key, value] of Object.entries(attributes)) {
    const current = record.get(key);
    const unset = current === undefined || current === null || current === "" || (Array.isArray(current) && !current.length);
    if (unset && value !== undefined) {
      record.set(key, value);
      changed = true;
    }
  }
  if (changed) await record.save(null, master);
  return { record, created, changed };
}

/**
 * 将记录 Pointer 加入数组字段而不重复，保留管理员已有的扩展路由或权限配置。
 * @param {Parse.Object} record 需要修改的 Parse 配置记录。
 * @param {string} fieldName Array Pointer 字段名。
 * @param {Parse.Object[]} items 需要确保存在的关联记录。
 * @returns {Promise<boolean>} 数组实际发生变化时返回 true。
 * @throws {Error} 保存关联关系失败时抛出。
 */
async function ensurePointers(record, fieldName, items) {
  const current = Array.isArray(record.get(fieldName)) ? [...record.get(fieldName)] : [];
  const ids = new Set(current.map(pointerId).filter(Boolean));
  let changed = false;
  for (const item of items) {
    if (item?.id && !ids.has(item.id)) {
      current.push(pointer(item));
      ids.add(item.id);
      changed = true;
    }
  }
  if (changed) {
    record.set(fieldName, current);
    await record.save(null, master);
  }
  return changed;
}

/**
 * 为当前 Company 补齐 Module、Route 与 Schema 元数据，使系统管理员在旧数据库或首次迁移后仍能直接进入基础配置页。
 * @param {{company: Parse.Object, companyId: string, isAdmin?: boolean}} auth authenticate 中间件提供的可信认证上下文。
 * @returns {Promise<{created: string[], updated: string[]}>} 本次创建或补齐的系统配置键列表。
 * @throws {import("../lib/http-error").HttpError} 非系统管理员触发时抛出 403。
 */
async function ensureSystemConfiguration(auth) {
  assertSystemAdministrator(auth);
  await Promise.all([ensureOrganizationInfrastructure(), ensurePositionInfrastructure()]);
  clearSchemaCache();
  const result = { created: [], updated: [] };
  const company = auth.company;

  for (const definition of configurationMetadataDefinitions()) {
    const ensured = await ensureRecord("Schema", `schema.${definition.name}`, company, {
      name: definition.name,
      nickName: definition.nickName,
      fields: definition.fields,
    });
    const metadataFields = mergeMissingMetadataFields(definition.fields, ensured.record.get("fields"));
    if (metadataFields.changed) {
      ensured.record.set("fields", metadataFields.fields);
      await ensured.record.save(null, master);
    }
    if (ensured.created) result.created.push(`Schema:${definition.name}`);
    else if (ensured.changed || metadataFields.changed) result.updated.push(`Schema:${definition.name}`);
  }

  const homeRoute = await ensureRecord("Route", "system.home.page", company, {
    name: "首页",
    path: "home",
    rank: 1,
    menu: true,
    pageComponent: "/home",
    targetClass: "Dashboard",
    remark: "企业工作台首页入口",
  });
  const homeModule = await ensureRecord("Module", "system.home", company, {
    name: "首页",
    path: "home",
    rank: 1,
    menu: true,
    icon: "HomeOutlined",
    pageComponent: "/home",
    remark: "静态首页的页面权限元数据",
  });
  const moduleRoute = await ensureRecord("Route", "system.module", company, {
    name: "模块管理",
    path: "module",
    rank: 1,
    menu: true,
    pageComponent: "/system/module/index",
    targetClass: "Route",
    remark: "配置后台模块、路由和页面入口",
  });
  const schemaRoute = await ensureRecord("Route", "system.schema", company, {
    name: "表格管理",
    path: "table",
    rank: 2,
    menu: true,
    pageComponent: "/system/table/index",
    targetClass: "Schema",
    remark: "管理业务表、字段和自动生成页面",
  });
  const organizationRoute = await ensureRecord("Route", "system.organization", company, {
    name: "组织管理",
    path: "organization",
    rank: 3,
    menu: true,
    pageComponent: "/system/organization/index",
    targetClass: ORGANIZATION_CLASS,
    remark: "配置企业组织树与组织节点",
  });
  // 仅迁移曾由平台默认创建的旧名称，不覆盖管理员为该系统入口写入的自定义名称。
  if (organizationRoute.record.get("name") === "组织与成员") {
    organizationRoute.record.set("name", "组织管理");
    organizationRoute.record.set("remark", "配置企业组织树与组织节点");
    await organizationRoute.record.save(null, master);
    organizationRoute.changed = true;
  }
  const memberRoute = await ensureRecord("Route", "system.member", company, {
    name: "成员管理",
    path: "member",
    rank: 4,
    menu: true,
    pageComponent: "/system/member/index",
    targetClass: "_User",
    remark: "配置成员岗位、关联组织和组织数据权限",
  });
  const positionRoute = await ensureRecord("Route", "system.position", company, {
    name: "岗位管理",
    path: "position",
    rank: 5,
    menu: true,
    pageComponent: "/system/position/index",
    targetClass: "Role",
    remark: "配置岗位可访问页面及页面内按钮权限",
  });
  const onlineMemberRoute = await ensureRecord("Route", "system.online-member", company, {
    name: "在线成员",
    path: "online-member",
    rank: 6,
    menu: true,
    pageComponent: "/system/online-member/index",
    targetClass: "_User",
    remark: "查看在线成员并执行强制下线与账号冻结",
  });
  const systemModule = await ensureRecord("Module", "system.management", company, {
    name: "系统管理",
    path: "system",
    rank: 10,
    menu: true,
    icon: "SettingOutlined",
    remark: "仅系统管理员可维护的基础配置",
  });
  const homeLinksChanged = await ensurePointers(homeModule.record, "routes", [homeRoute.record]);
  const linksChanged = await ensurePointers(systemModule.record, "routes", [
    moduleRoute.record,
    schemaRoute.record,
    organizationRoute.record,
    memberRoute.record,
    positionRoute.record,
    onlineMemberRoute.record,
  ]);
  if (homeRoute.created) result.created.push("Route:home");
  else if (homeRoute.changed) result.updated.push("Route:home");
  if (homeModule.created) result.created.push("Module:home");
  else if (homeModule.changed || homeLinksChanged) result.updated.push("Module:home");
  if (moduleRoute.created) result.created.push("Route:module");
  else if (moduleRoute.changed) result.updated.push("Route:module");
  if (schemaRoute.created) result.created.push("Route:table");
  else if (schemaRoute.changed) result.updated.push("Route:table");
  if (organizationRoute.created) result.created.push("Route:organization");
  else if (organizationRoute.changed) result.updated.push("Route:organization");
  if (memberRoute.created) result.created.push("Route:member");
  else if (memberRoute.changed) result.updated.push("Route:member");
  if (positionRoute.created) result.created.push("Route:position");
  else if (positionRoute.changed) result.updated.push("Route:position");
  if (onlineMemberRoute.created) result.created.push("Route:online-member");
  else if (onlineMemberRoute.changed) result.updated.push("Route:online-member");
  if (systemModule.created) result.created.push("Module:system");
  else if (systemModule.changed || linksChanged) result.updated.push("Module:system");
  clearSchemaCache();
  return result;
}

module.exports = { ensureSystemConfiguration };
