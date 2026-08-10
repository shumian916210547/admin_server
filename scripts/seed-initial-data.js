"use strict";

/*
 * Creates the Parse classes and the minimum system data required by the
 * current Vue application. It is safe to run repeatedly: existing records are
 * preserved and only missing fields, links, and seed records are added.
 *
 * Required environment variables are loaded from ../.env. The Parse server
 * must already be listening on its internal endpoint before this script runs.
 */

const Parse = require("parse/node");
const { config: environment } = require("../config/env");

const config = {
  appId: environment.parse.appId,
  masterKey: environment.parse.masterKey,
  serverURL: environment.parse.serverUrl,
};

Parse.initialize(config.appId, undefined, config.masterKey);
Parse.masterKey = config.masterKey;
Parse.serverURL = config.serverURL;

function initialAdministratorCredentials() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password || password.length < 12) {
    throw new Error(
      "INITIAL_ADMIN_USERNAME and an INITIAL_ADMIN_PASSWORD of at least 12 characters are required"
    );
  }
  return { username, password };
}

const field = (type, options = {}) => ({ type, ...options });

const coreSchemas = [
  {
    className: "Company",
    fields: {
      systemKey: field("String"),
      name: field("String", { required: true }),
      company: field("Pointer", { targetClass: "Company" }),
      admin: field("Array"),
    },
  },
  {
    className: "Role",
    fields: {
      systemKey: field("String"),
      name: field("String", { required: true }),
      company: field("Pointer", { targetClass: "Company" }),
      module: field("Array"),
      positionManaged: field("Boolean"),
    },
  },
  {
    className: "Route",
    fields: {
      systemKey: field("String"),
      name: field("String", { required: true }),
      path: field("String", { required: true }),
      rank: field("Number"),
      menu: field("Boolean"),
      remark: field("String"),
      pageComponent: field("String"),
      targetClass: field("String"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Module",
    fields: {
      systemKey: field("String"),
      name: field("String", { required: true }),
      path: field("String", { required: true }),
      rank: field("Number"),
      menu: field("Boolean"),
      icon: field("String"),
      remark: field("String"),
      pageComponent: field("String"),
      targetClass: field("String"),
      routes: field("Array"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Schema",
    fields: {
      systemKey: field("String"),
      name: field("String", { required: true }),
      nickName: field("String", { required: true }),
      fields: field("Object"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "AllotPermission",
    fields: {
      systemKey: field("String"),
      name: field("String"),
      role: field("Pointer", { targetClass: "Role" }),
      routes: field("Array"),
      permissions: field("Array"),
      routePermissions: field("Object"),
      positionManaged: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Organization",
    fields: {
      company: field("Pointer", { targetClass: "Company" }),
      parent: field("Pointer", { targetClass: "Organization" }),
      name: field("String", { required: true }),
      code: field("String"),
      type: field("String"),
      rank: field("Number"),
      isActive: field("Boolean"),
      remark: field("String"),
    },
  },
  {
    className: "_User",
    fields: {
      name: field("String"),
      nickname: field("String"),
      company: field("Pointer", { targetClass: "Company" }),
      role: field("Pointer", { targetClass: "Role" }),
      organization: field("Pointer", { targetClass: "Organization" }),
      organizationIds: field("Array"),
      organizationScopes: field("Array"),
      organizationAdmin: field("Boolean"),
      isDelete: field("Boolean"),
    },
  },
];

// These classes are used by the server's legacy generic APIs and attendance
// endpoints. They are deliberately created without sample business records.
const serverSchemas = [
  {
    className: "DevSchema",
    fields: {
      name: field("String"),
      isDelete: field("Boolean"),
      fields: field("Object"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "DevModule",
    fields: {
      name: field("String"),
      path: field("String"),
      meta: field("Object"),
      router: field("Array"),
      user: field("Pointer", { targetClass: "_User" }),
      isDelete: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "DevRoute",
    fields: {
      name: field("String"),
      path: field("String"),
      pagePath: field("String"),
      option: field("Object"),
      switchs: field("Array"),
      isDelete: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Identity",
    fields: {
      name: field("String"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Switch",
    fields: {
      name: field("String"),
      isDelete: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "School",
    fields: {
      name: field("String"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Department",
    fields: {
      name: field("String"),
      school: field("Pointer", { targetClass: "School" }),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Major",
    fields: {
      name: field("String"),
      department: field("Pointer", { targetClass: "Department" }),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Class",
    fields: {
      name: field("String"),
      major: field("Pointer", { targetClass: "Major" }),
      department: field("Pointer", { targetClass: "Department" }),
      isDelete: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Student",
    fields: {
      name: field("String"),
      studentID: field("String"),
      loginPwd: field("String"),
      class: field("Pointer", { targetClass: "Class" }),
      isDelete: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Course",
    fields: {
      name: field("String"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Teacher",
    fields: {
      name: field("String"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Schedule",
    fields: {
      date: field("String"),
      class: field("Pointer", { targetClass: "Class" }),
      course: field("Pointer", { targetClass: "Course" }),
      teacher: field("Pointer", { targetClass: "Teacher" }),
      isDelete: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "Task",
    fields: {
      code: field("String"),
      date: field("String"),
      start_time: field("String"),
      end_time: field("String"),
      class: field("Pointer", { targetClass: "Class" }),
      course: field("Pointer", { targetClass: "Course" }),
      isDelete: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
  {
    className: "TaskDetail",
    fields: {
      status: field("Boolean"),
      time: field("String"),
      task: field("Pointer", { targetClass: "Task" }),
      class: field("Pointer", { targetClass: "Class" }),
      student: field("Pointer", { targetClass: "Student" }),
      isDelete: field("Boolean"),
      company: field("Pointer", { targetClass: "Company" }),
    },
  },
];

function addSchemaField(schema, name, definition) {
  const options = definition.targetClass
    ? { targetClass: definition.targetClass }
    : {};
  if (definition.required !== undefined) options.required = definition.required;
  if (definition.defaultValue !== undefined) {
    options.defaultValue = definition.defaultValue;
  }
  schema.addField(name, definition.type, options);
}

async function ensureSchemas(definitions) {
  const schemas = await Parse.Schema.all();
  const existing = new Map(schemas.map((schema) => [schema.className, schema]));
  const summary = { created: [], updated: [], conflicts: [] };

  for (const definition of definitions) {
    const current = existing.get(definition.className);
    const currentFields = current ? current.fields || {} : {};
    const missing = Object.entries(definition.fields).filter(
      ([name]) => !currentFields[name]
    );

    for (const [name, desired] of Object.entries(definition.fields)) {
      const actual = currentFields[name];
      if (
        actual &&
        (actual.type !== desired.type ||
          (desired.targetClass && actual.targetClass !== desired.targetClass))
      ) {
        summary.conflicts.push(`${definition.className}.${name}`);
      }
    }

    if (!current) {
      const schema = new Parse.Schema(definition.className);
      Object.entries(definition.fields).forEach(([name, item]) =>
        addSchemaField(schema, name, item)
      );
      await schema.save();
      summary.created.push(definition.className);
    } else if (missing.length) {
      const schema = new Parse.Schema(definition.className);
      missing.forEach(([name, item]) => addSchemaField(schema, name, item));
      await schema.update();
      summary.updated.push(definition.className);
    }
  }

  return summary;
}

function pointer(object) {
  return {
    __type: "Pointer",
    className: object.className,
    objectId: object.id,
  };
}

function pointerId(value) {
  return value && (value.id || value.objectId);
}

function isUnset(value) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

async function findBySystemKey(className, systemKey) {
  const query = new Parse.Query(className);
  query.equalTo("systemKey", systemKey);
  return query.first({ useMasterKey: true });
}

async function ensureObject(className, systemKey, attributes) {
  let object = await findBySystemKey(className, systemKey);
  const created = !object;
  if (!object) {
    const ObjectClass = Parse.Object.extend(className);
    object = new ObjectClass();
    object.set("systemKey", systemKey);
  }

  let changed = created;
  for (const [name, value] of Object.entries(attributes)) {
    if (isUnset(object.get(name)) && value !== undefined) {
      object.set(name, value);
      changed = true;
    }
  }

  if (changed) await object.save(null, { useMasterKey: true });
  return { object, created, changed };
}

async function addPointers(object, fieldName, objects) {
  const current = Array.isArray(object.get(fieldName))
    ? [...object.get(fieldName)]
    : [];
  const ids = new Set(current.map(pointerId).filter(Boolean));
  let changed = false;

  for (const item of objects) {
    if (item && !ids.has(item.id)) {
      current.push(pointer(item));
      ids.add(item.id);
      changed = true;
    }
  }

  if (changed) {
    object.set(fieldName, current);
    await object.save(null, { useMasterKey: true });
  }
  return changed;
}

async function ensureAdministrator(role, company, credentials) {
  const query = new Parse.Query(Parse.User);
  query.equalTo("username", credentials.username);
  let user = await query.first({ useMasterKey: true });
  const created = !user;

  if (!user) {
    user = new Parse.User();
    user.set("username", credentials.username);
    user.set("password", credentials.password);
    user.set("name", "系统管理员");
    user.set("isDelete", false);
    user.set("company", pointer(company));
    user.set("role", pointer(role));
    await user.signUp(null, { useMasterKey: true });
  } else {
    let changed = false;
    if (isUnset(user.get("name"))) {
      user.set("name", "系统管理员");
      changed = true;
    }
    if (isUnset(user.get("company"))) {
      user.set("company", pointer(company));
      changed = true;
    }
    if (isUnset(user.get("role"))) {
      user.set("role", pointer(role));
      changed = true;
    }
    if (isUnset(user.get("isDelete"))) {
      user.set("isDelete", false);
      changed = true;
    }
    if (changed) await user.save(null, { useMasterKey: true });
  }

  return { user, created };
}

function componentOption(overrides = {}) {
  return {
    placeholder: "",
    disabled: false,
    allowClear: true,
    mode: "combobox",
    selectTable: undefined,
    labelKey: "name",
    valueKey: "objectId",
    fieldNames: undefined,
    maxLength: 8,
    fileType: "*",
    maxCount: 1,
    ...overrides,
  };
}

function uiField(type, chineseName, options = {}) {
  const result = {
    type,
    required: Boolean(options.required),
    chineseName,
    editComponent:
      options.editComponent ||
      (type === "Boolean" ? "ASwitch" : type === "Number" ? "AInputNumber" : "AInput"),
    targetClass: options.targetClass,
    isFilter: Boolean(options.isFilter),
    isTable: Boolean(options.isTable),
    isPointer: Boolean(options.isPointer),
    isSole: Boolean(options.isSole),
    componentOption: componentOption(options.componentOption),
  };
  if (options.defaultValue !== undefined) result.defaultValue = options.defaultValue;
  return result;
}

function defaultFields() {
  return {
    objectId: uiField("String", "对象 ID", {
      editComponent: "AInput",
      componentOption: { disabled: true, allowClear: false },
    }),
    company: uiField("Pointer", "公司", {
      required: true,
      targetClass: "Company",
      isPointer: true,
      editComponent: "ASelect",
      componentOption: { selectTable: "Company", allowClear: false },
    }),
    createdAt: uiField("Date", "创建时间", {
      editComponent: "AInput",
      componentOption: { disabled: true, allowClear: false },
    }),
    updatedAt: uiField("Date", "更新时间", {
      editComponent: "AInput",
      componentOption: { disabled: true, allowClear: false },
    }),
  };
}

function textField(chineseName, options = {}) {
  return uiField("String", chineseName, options);
}

function numberField(chineseName, options = {}) {
  return uiField("Number", chineseName, options);
}

function booleanField(chineseName, options = {}) {
  return uiField("Boolean", chineseName, options);
}

function pointerField(chineseName, targetClass, options = {}) {
  return uiField("Pointer", chineseName, {
    ...options,
    targetClass,
    isPointer: true,
    editComponent: "ASelect",
    componentOption: { selectTable: targetClass, ...options.componentOption },
  });
}

function pointerArrayField(chineseName, targetClass, options = {}) {
  return uiField("Array", chineseName, {
    ...options,
    targetClass,
    isPointer: true,
    editComponent: "ASelect",
    componentOption: {
      mode: "multiple",
      selectTable: targetClass,
      ...options.componentOption,
    },
  });
}

function metadataDefinitions() {
  return [
    {
      name: "Company",
      nickName: "公司",
      fields: {
        ...defaultFields(),
        name: textField("名称", { required: true, isFilter: true, isTable: true }),
        admin: pointerArrayField("管理员", "_User", { isTable: true }),
      },
    },
    {
      name: "Role",
      nickName: "角色",
      fields: {
        ...defaultFields(),
        name: textField("名称", { required: true, isFilter: true, isTable: true }),
        module: pointerArrayField("可访问模块", "Module"),
        positionManaged: booleanField("由岗位管理维护", { defaultValue: false }),
      },
    },
    {
      name: "Module",
      nickName: "模块",
      fields: {
        ...defaultFields(),
        name: textField("名称", { required: true, isFilter: true, isTable: true }),
        path: textField("路径", { required: true, isTable: true }),
        rank: numberField("排序", { defaultValue: 0, isTable: true }),
        menu: booleanField("显示菜单", { defaultValue: true, isTable: true }),
        icon: textField("图标", { isTable: true }),
        pageComponent: textField("页面组件"),
        targetClass: textField("目标表"),
        remark: textField("备注", { isTable: true }),
        routes: pointerArrayField("子路由", "Route"),
      },
    },
    {
      name: "Route",
      nickName: "路由",
      fields: {
        ...defaultFields(),
        name: textField("名称", { required: true, isFilter: true, isTable: true }),
        path: textField("路径", { required: true, isTable: true }),
        rank: numberField("排序", { defaultValue: 0, isTable: true }),
        menu: booleanField("显示菜单", { defaultValue: true, isTable: true }),
        pageComponent: textField("页面组件", { isTable: true }),
        targetClass: textField("目标表", { isTable: true }),
        remark: textField("备注", { isTable: true }),
      },
    },
    {
      name: "Schema",
      nickName: "表结构配置",
      fields: {
        ...defaultFields(),
        name: textField("表名", { required: true, isFilter: true, isTable: true }),
        nickName: textField("表别名", { required: true, isTable: true }),
        fields: uiField("Object", "字段配置", { editComponent: "AInput" }),
      },
    },
    {
      name: "Organization",
      nickName: "组织架构",
      fields: {
        ...defaultFields(),
        name: textField("组织名称", { required: true, isFilter: true, isTable: true }),
        code: textField("组织编码", { isFilter: true, isTable: true }),
        type: textField("组织类型", { isTable: true }),
        parent: pointerField("上级组织", "Organization"),
        rank: numberField("排序", { defaultValue: 0, isTable: true }),
        isActive: booleanField("启用", { defaultValue: true, isTable: true }),
        remark: textField("备注"),
      },
    },
    {
      name: "AllotPermission",
      nickName: "权限分配",
      fields: {
        ...defaultFields(),
        name: textField("名称", { isTable: true }),
        role: pointerField("角色", "Role", { isTable: true }),
        routes: pointerArrayField("路由", "Route", { isTable: true }),
        permissions: uiField("Array", "按钮权限", { editComponent: "ASelect", componentOption: { mode: "tags" } }),
        routePermissions: uiField("Object", "逐页按钮权限", { editComponent: "AInput" }),
        positionManaged: booleanField("由岗位管理维护", { defaultValue: false }),
      },
    },
  ];
}

async function ensureMetadata(company) {
  const summary = { created: [], updated: [] };
  for (const definition of metadataDefinitions()) {
    const systemKey = `schema.${definition.name}`;
    const found = await findBySystemKey("Schema", systemKey);
    if (!found) {
      const SchemaObject = Parse.Object.extend("Schema");
      const object = new SchemaObject();
      object.set("systemKey", systemKey);
      object.set("name", definition.name);
      object.set("nickName", definition.nickName);
      object.set("fields", definition.fields);
      object.set("company", pointer(company));
      await object.save(null, { useMasterKey: true });
      summary.created.push(definition.name);
      continue;
    }

    const currentFields = found.get("fields") || {};
    const mergedFields = { ...definition.fields, ...currentFields };
    let changed = false;
    if (Object.keys(currentFields).length !== Object.keys(mergedFields).length) {
      found.set("fields", mergedFields);
      changed = true;
    }
    if (isUnset(found.get("nickName"))) {
      found.set("nickName", definition.nickName);
      changed = true;
    }
    if (isUnset(found.get("company"))) {
      found.set("company", pointer(company));
      changed = true;
    }
    if (changed) {
      await found.save(null, { useMasterKey: true });
      summary.updated.push(definition.name);
    }
  }
  return summary;
}

async function main() {
  const administratorCredentials = initialAdministratorCredentials();
  const schemaSummary = await ensureSchemas([...coreSchemas, ...serverSchemas]);

  const companyResult = await ensureObject("Company", "system.root", {
    name: "综合后台管理系统",
  });
  const company = companyResult.object;
  if (isUnset(company.get("company"))) {
    company.set("company", pointer(company));
    await company.save(null, { useMasterKey: true });
  }

  const homeRoute = (
    await ensureObject("Route", "system.home.page", {
      name: "首页",
      path: "home",
      rank: 1,
      menu: true,
      pageComponent: "/home",
      targetClass: "Dashboard",
      company: pointer(company),
    })
  ).object;
  const moduleRoute = (
    await ensureObject("Route", "system.module", {
      name: "模块管理",
      path: "module",
      rank: 1,
      menu: true,
      pageComponent: "/system/module/index",
      targetClass: "Route",
      company: pointer(company),
    })
  ).object;
  const schemaRoute = (
    await ensureObject("Route", "system.schema", {
      name: "表格管理",
      path: "table",
      rank: 2,
      menu: true,
      pageComponent: "/system/table/index",
      targetClass: "Schema",
      company: pointer(company),
    })
  ).object;
  const organizationRoute = (
    await ensureObject("Route", "system.organization", {
      name: "组织管理",
      path: "organization",
      rank: 3,
      menu: true,
      pageComponent: "/system/organization/index",
      targetClass: "Organization",
      company: pointer(company),
    })
  ).object;
  const memberRoute = (
    await ensureObject("Route", "system.member", {
      name: "成员管理",
      path: "member",
      rank: 4,
      menu: true,
      pageComponent: "/system/member/index",
      targetClass: "_User",
      company: pointer(company),
    })
  ).object;
  const positionRoute = (
    await ensureObject("Route", "system.position", {
      name: "岗位管理",
      path: "position",
      rank: 5,
      menu: true,
      pageComponent: "/system/position/index",
      targetClass: "Role",
      company: pointer(company),
    })
  ).object;
  const onlineMemberRoute = (
    await ensureObject("Route", "system.online-member", {
      name: "在线成员",
      path: "online-member",
      rank: 6,
      menu: true,
      pageComponent: "/system/online-member/index",
      targetClass: "_User",
      company: pointer(company),
    })
  ).object;

  const homeModule = (
    await ensureObject("Module", "system.home", {
      name: "首页",
      path: "home",
      rank: 1,
      menu: true,
      icon: "HomeOutlined",
      pageComponent: "/home",
      company: pointer(company),
    })
  ).object;
  await addPointers(homeModule, "routes", [homeRoute]);
  const systemModule = (
    await ensureObject("Module", "system.management", {
      name: "系统管理",
      path: "system",
      rank: 10,
      menu: true,
      icon: "SettingOutlined",
      company: pointer(company),
    })
  ).object;
  await addPointers(systemModule, "routes", [
    moduleRoute,
    schemaRoute,
    organizationRoute,
    memberRoute,
    positionRoute,
    onlineMemberRoute,
  ]);

  const role = (
    await ensureObject("Role", "system.administrator", {
      name: "系统管理员",
      company: pointer(company),
    })
  ).object;
  await addPointers(role, "module", [
    homeModule,
    homeRoute,
    systemModule,
    moduleRoute,
    schemaRoute,
    organizationRoute,
    memberRoute,
    positionRoute,
    onlineMemberRoute,
  ]);

  const { user, created: createdUser } = await ensureAdministrator(
    role,
    company,
    administratorCredentials
  );
  await addPointers(company, "admin", [user]);

  const permission = (
    await ensureObject("AllotPermission", "system.administrator.all", {
      name: "系统管理员全量权限",
      role: pointer(role),
      company: pointer(company),
      permissions: [
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
        "permission:forceLogout",
        "permission:freeze",
      ],
    })
  ).object;
  await addPointers(permission, "routes", [
    homeRoute,
    moduleRoute,
    schemaRoute,
    organizationRoute,
    memberRoute,
    positionRoute,
    onlineMemberRoute,
  ]);

  const metadataSummary = await ensureMetadata(company);
  const result = {
    parseServer: config.serverURL,
    schema: schemaSummary,
    metadata: metadataSummary,
    companyId: company.id,
    roleId: role.id,
    userId: user.id,
    createdDefaultUser: createdUser,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
