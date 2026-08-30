"use strict";

/**
 * 通过当前 BFF 公开 HTTP 契约执行协同表格多角色回归，不直接写入 Parse 或 PostgreSQL。
 * 测试账号使用本地 .env 中的管理员凭据登录，临时成员只在当前 Company 内创建并在结束时停用。
 */

const assert = require("assert/strict");
const crypto = require("crypto");
const dotenv = require("dotenv");
const path = require("path");

const { queryCollab } = require("../services/collab-database.service");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const apiBaseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`;
const browserOrigin = process.env.PUBLIC_ORIGIN || "http://localhost:4200";
const cookieName = process.env.AUTH_COOKIE_NAME || "shumian_admin_session";
const administratorUsername = process.env.INITIAL_ADMIN_USERNAME;
const administratorPassword = process.env.INITIAL_ADMIN_PASSWORD;
const testSuffix = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
const spreadsheetPermissions = [
  "permission:query",
  "permission:insert",
  "permission:edit",
  "permission:remove",
  "permission:import",
  "permission:export",
  "permission:share",
  "permission:history",
];

let passed = 0;

/**
 * 从 BFF 响应中提取业务数据，兼容统一 { data } 包装和直接返回的测试辅助结构。
 * @param {{body?: unknown}} response 已解析 JSON 的 HTTP 响应对象。
 * @returns {any} 响应中的业务数据；无 data 字段时返回整个响应体。
 */
function dataOf(response) {
  return response?.body && Object.prototype.hasOwnProperty.call(response.body, "data")
    ? response.body.data
    : response?.body;
}

/**
 * 记录一个已通过断言的用例，输出不包含账号、密码、Cookie 或对象存储路径。
 * @param {string} label 用例中文名称或安全的英文标识。
 * @returns {void} 更新通过计数并写入标准输出。
 */
function pass(label) {
  passed += 1;
  console.log(`PASS ${label}`);
}

/**
 * 转义 Cookie 名称以便安全地构造正则表达式。
 * @param {string} value 待转义的 Cookie 名称。
 * @returns {string} 可放入正则表达式的转义文本。
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从响应头读取当前会话 Cookie，兼容 Node fetch 的 getSetCookie 和合并后的 set-cookie 表现。
 * @param {Headers} headers Fetch 响应头集合。
 * @returns {string | null} 当前认证 Cookie 键值对；未下发时返回 null。
 */
function readSessionCookie(headers) {
  const getSetCookie = headers.getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [headers.get("set-cookie") || ""];
  const pattern = new RegExp(`${escapeRegExp(cookieName)}=[^;]+`);
  for (const cookie of cookies) {
    const match = String(cookie || "").match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * 将 JSON 或文件响应解析成统一测试结构，并保留导出文件字节供后续 xlsx 导入回归复用。
 * @param {Response} response Fetch 原始响应。
 * @returns {Promise<{status: number, headers: Headers, body: any, bytes: Buffer | null}>} 可断言的响应结构。
 */
async function parseResponse(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return { status: response.status, headers: response.headers, body: await response.json(), bytes: null };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body: null, bytes };
}

/**
 * 维护一个带 HttpOnly Cookie 和 CSRF 令牌的 BFF 测试会话。
 * @param {string} label 会话角色标识，仅用于错误和调试输出。
 */
class ApiClient {
  /**
   * 创建空认证会话；登录成功后由 login 方法填充 Cookie 和 CSRF 令牌。
   * @param {string} label 会话角色标识。
   * @returns {void} 初始化客户端状态。
   */
  constructor(label) {
    this.label = label;
    this.cookie = "";
    this.csrf = "";
  }

  /**
   * 发起同源风格的 BFF 请求，并自动保存服务端续期的 HttpOnly Cookie。
   * @param {string} requestPath 以 /api 开头的相对请求路径。
   * @param {{method?: string, body?: unknown, form?: FormData, csrf?: boolean, origin?: string | null}} [options] 请求方法、JSON 或 multipart 请求体及安全头配置。
   * @returns {Promise<{status: number, headers: Headers, body: any, bytes: Buffer | null}>} 已解析的响应。
   * @throws {Error} 网络不可用或响应体解析失败时抛出。
   */
  async request(requestPath, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = { Accept: "application/json" };
    if (options.origin !== null) headers.Origin = options.origin || browserOrigin;
    if (this.cookie) headers.Cookie = this.cookie;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.form) {
      delete headers["Content-Type"];
    }
    if (options.csrf !== false && !["GET", "HEAD", "OPTIONS"].includes(method) && this.csrf) {
      headers["X-CSRF-Token"] = this.csrf;
    }
    const response = await fetch(`${apiBaseUrl}${requestPath}`, {
      method,
      headers,
      body: options.form || (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const sessionCookie = readSessionCookie(response.headers);
    if (sessionCookie) this.cookie = sessionCookie;
    return parseResponse(response);
  }
}

/**
 * 断言 HTTP 状态码，失败时附带安全的错误码和角色标签，避免把凭据写入日志。
 * @param {Promise<{status: number, body: any}>} responsePromise 待等待的请求。
 * @param {number | number[]} expectedStatus 允许的 HTTP 状态码或状态码数组。
 * @param {string} label 用例名称。
 * @returns {Promise<{status: number, headers: Headers, body: any, bytes: Buffer | null}>} 原始响应结构。
 * @throws {AssertionError} 实际状态码不在允许集合中时抛出。
 */
async function expectStatus(responsePromise, expectedStatus, label) {
  const response = await responsePromise;
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  assert.ok(
    expected.includes(response.status),
    `${label} (${response.status}, ${response.body?.error?.code || "no-error-code"})`,
  );
  pass(label);
  return response;
}

/**
 * 断言业务错误码，确保权限拒绝和输入拒绝走稳定的 BFF 契约。
 * @param {{status: number, body: any}} response 已完成的错误响应。
 * @param {number} status 期望的 HTTP 状态码。
 * @param {string | string[]} codes 期望的业务错误码或可接受错误码列表。
 * @param {string} label 用例名称。
 * @returns {void} 断言通过后记录用例。
 * @throws {AssertionError} 状态码或错误码不符合预期时抛出。
 */
function expectError(response, status, codes, label) {
  const expectedCodes = Array.isArray(codes) ? codes : [codes];
  assert.equal(response.status, status, `${label} status`);
  assert.ok(expectedCodes.includes(response.body?.error?.code), `${label} code`);
  pass(label);
}

/**
 * 登录一个 BFF 会话并验证服务端可以恢复该会话。
 * @param {string} username 本地测试账号用户名，仅在请求体中使用。
 * @param {string} password 本地测试账号密码，仅在请求体中使用。
 * @param {string} label 会话角色名称。
 * @returns {Promise<ApiClient>} 已保存认证 Cookie、CSRF 和恢复结果的客户端。
 * @throws {AssertionError|Error} 登录失败、Cookie 缺失或会话恢复失败时抛出。
 */
async function login(username, password, label) {
  const client = new ApiClient(label);
  const response = await expectStatus(
    client.request("/api/auth/login", { method: "POST", body: { username, password }, csrf: false }),
    200,
    `${label} 登录`,
  );
  client.csrf = dataOf(response)?.csrfToken || "";
  client.userId = dataOf(response)?.user?.objectId || dataOf(response)?.user?.id || "";
  client.userName = dataOf(response)?.user?.name || dataOf(response)?.user?.nickname || dataOf(response)?.user?.username || "";
  assert.ok(client.cookie, `${label} session cookie`);
  assert.ok(client.csrf, `${label} csrf token`);
  await expectStatus(client.request("/api/auth/session"), 200, `${label} 恢复会话`);
  return client;
}

/**
 * 创建一个适合 multipart 上传的文件表单，保持浏览器端使用的文件名和 MIME 契约。
 * @param {Buffer|string} content 文件内容。
 * @param {string} fileName 原始文件名，仅用于服务端格式判断。
 * @param {string} mimeType 浏览器声明的 MIME 类型。
 * @returns {FormData} 包含 file 字段的 multipart 表单。
 */
function fileForm(content, fileName, mimeType) {
  const form = new FormData();
  const blob = new Blob([content], { type: mimeType });
  form.append("file", blob, fileName);
  return form;
}

/**
 * 创建测试岗位并验证岗位目录确实包含协同表格页面和所需按钮权限。
 * @param {ApiClient} admin 系统管理员会话。
 * @returns {Promise<{routeId: string, positions: Record<string, string>}>} 协同路由标识和各测试岗位 ID。
 * @throws {AssertionError|Error} 岗位目录缺失或创建接口失败时抛出。
 */
async function createTestPositions(admin) {
  const overviewResponse = await expectStatus(
    admin.request("/api/positions/overview"),
    200,
    "读取岗位与页面目录",
  );
  const overview = dataOf(overviewResponse);
  const route = overview.routes.find(
    (item) => item.path === "spreadsheet" || item.pageComponent === "/collab/spreadsheet/index" || item.targetClass === "CollabDocument",
  );
  assert.ok(route?.objectId, "collab spreadsheet route");
  const available = new Set(route.availablePermissions || []);
  assert.ok(spreadsheetPermissions.every((permission) => available.has(permission)), "collab page permissions");

  const definitions = {
    editor: spreadsheetPermissions.filter((permission) =>
      ["permission:query", "permission:edit", "permission:import", "permission:export", "permission:history"].includes(permission),
    ),
    commenter: ["permission:query", "permission:edit", "permission:history"],
    viewer: ["permission:query", "permission:export", "permission:history"],
  };
  const positions = {};
  for (const [role, permissions] of Object.entries(definitions)) {
    const response = await expectStatus(
      admin.request("/api/positions", {
        method: "POST",
        body: {
          name: `协同回归-${role}-${testSuffix}`,
          pagePermissions: [{ routeId: route.objectId, permissions }],
        },
      }),
      201,
      `创建${role}岗位`,
    );
    positions[role] = dataOf(response).objectId;
  }
  return { routeId: route.objectId, positions };
}

/**
 * 创建两个组织节点，用于验证文档组织范围和企业内公开访问不会越过组织边界。
 * @param {ApiClient} admin 系统管理员会话。
 * @returns {Promise<{inScopeId: string, outOfScopeId: string}>} 同企业的组织范围测试节点。
 * @throws {AssertionError|Error} 组织创建失败时抛出。
 */
async function createTestOrganizations(admin) {
  const create = async (name, code) => {
    const response = await expectStatus(
      admin.request("/api/organization/nodes", {
        method: "POST",
        body: { name, code, type: "department", parentId: null, rank: 1, remark: "协同表格自动化回归数据" },
      }),
      201,
      `创建${name}`,
    );
    return dataOf(response).objectId;
  };
  return {
    inScopeId: await create(`协同回归组织内-${testSuffix}`, `COLLABQA-IN-${testSuffix}`),
    outOfScopeId: await create(`协同回归组织外-${testSuffix}`, `COLLABQA-OUT-${testSuffix}`),
  };
}

/**
 * 创建一个绑定组织范围和岗位的临时成员，返回登录所需凭据及服务端脱敏 DTO。
 * @param {ApiClient} admin 系统管理员会话。
 * @param {string} roleId 岗位 Role objectId。
 * @param {string} organizationId 成员关联和数据权限组织 objectId。
 * @param {string} roleName 测试角色标识。
 * @returns {Promise<{id: string, username: string, password: string}>} 临时成员安全测试信息。
 * @throws {AssertionError|Error} 成员创建失败时抛出。
 */
async function createTestMember(admin, roleId, organizationId, roleName) {
  const username = `collabqa_${testSuffix}_${roleName}`;
  const password = `CollabQA-${testSuffix}-Password!`;
  const response = await expectStatus(
    admin.request("/api/organization/members", {
      method: "POST",
      body: {
        username,
        password,
        name: `协同回归${roleName}`,
        nickname: `回归${roleName}`,
        email: `${username}@invalid.test`,
        roleId,
        organizationIds: [organizationId],
        scopeIds: [organizationId],
        organizationAdmin: false,
      },
    }),
    201,
    `创建${roleName}测试成员`,
  );
  return { id: dataOf(response).objectId, username, password };
}

/**
 * 创建并登记一份测试文档，保证后续三轮回归可以统一执行安全清理。
 * @param {ApiClient} client 已认证且具备协同文档新建权限的会话。
 * @param {Record<string, unknown>} payload 文档名称、访问模式、组织范围和下载开关。
 * @param {string[]} documents 测试上下文中的文档 ID 集合。
 * @param {string} label 黑盒用例标签。
 * @returns {Promise<Record<string, unknown>>} 新建文档安全 DTO。
 * @throws {AssertionError|Error} 创建失败、响应缺少文档 ID 或业务状态不符合预期时抛出。
 */
async function createTrackedDocument(client, payload, documents, label) {
  const response = await expectStatus(client.request("/api/collab/documents", { method: "POST", body: payload }), 201, label);
  const document = dataOf(response);
  assert.ok(document?.id, `${label} id`);
  documents.push(document.id);
  return document;
}

/**
 * 校验文档安全 DTO 的列表元数据字段，确保创建者、时间和当前版本文件大小不会因接口重构丢失。
 * @param {Record<string, unknown>} document 文档列表或详情 DTO。
 * @param {string} label 用例标签。
 * @returns {void} 元数据格式和非负文件大小断言通过后记录用例。
 * @throws {AssertionError} 必需字段缺失、时间非法或文件大小不是非负数时抛出。
 */
function assertDocumentMetadata(document, label) {
  assert.equal(typeof document?.createdByName, "string", `${label} createdByName`);
  assert.ok(document.createdByName.length > 0, `${label} createdByName non-empty`);
  assert.equal(typeof document?.ownerName, "string", `${label} ownerName`);
  assert.ok(document.ownerName.length > 0, `${label} ownerName non-empty`);
  assert.equal(typeof document?.updatedByName, "string", `${label} updatedByName`);
  assert.ok(document.updatedByName.length > 0, `${label} updatedByName non-empty`);
  assert.ok(Number.isFinite(Number(document?.fileSizeBytes)) && Number(document.fileSizeBytes) >= 0, `${label} fileSizeBytes`);
  assert.doesNotThrow(() => new Date(document.createdAt).toISOString(), `${label} createdAt ISO`);
  assert.doesNotThrow(() => new Date(document.updatedAt).toISOString(), `${label} updatedAt ISO`);
  pass(`${label} 返回创建者、时间和文件大小元数据`);
}

/**
 * 验证文档所有权转移的成功、权限、组织、乐观锁和审计闭环，并保留原所有者的编辑权限。
 * @param {{admin: ApiClient, editor: ApiClient, viewer: ApiClient, outsider: ApiClient, organizations: {inScopeId: string}, memberIds: Record<string, string>, documents: string[]}} context 三轮回归共用的认证会话、组织和资源集合。
 * @returns {Promise<void>} 所有权转移相关黑盒和数据库审计白盒断言完成后兑现。
 * @throws {AssertionError|Error} 所有权、租户、组织或并发版本契约不符合设计时抛出。
 */
async function runOwnershipTransferRegression(context) {
  const { admin, editor, viewer, outsider, organizations, memberIds, documents } = context;
  const ownershipDocument = await createTrackedDocument(
    admin,
    {
      name: `所有权转移回归-${testSuffix}`,
      accessMode: "members",
      organizationId: organizations.inScopeId,
      allowDownload: false,
    },
    documents,
    "创建所有权转移测试文档",
  );
  assertDocumentMetadata(ownershipDocument, "所有权转移初始文档");
  const acl = await expectStatus(
    admin.request(`/api/collab/documents/${ownershipDocument.id}/members`, {
      method: "PUT",
      body: {
        expectedAccessVersion: ownershipDocument.accessVersion,
        members: [{ userId: memberIds.editor, role: "viewer", canDownload: false }],
      },
    }),
    200,
    "为所有权转移准备有效成员 ACL",
  );
  const accessVersion = dataOf(acl).accessVersion;

  expectError(
    await admin.request(`/api/collab/documents/${ownershipDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: memberIds.editor, expectedAccessVersion: accessVersion },
      csrf: false,
    }),
    403,
    "FORBIDDEN",
    "所有权转移接口必须携带 CSRF",
  );
  expectError(
    await admin.request(`/api/collab/documents/${ownershipDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: admin.userId, expectedAccessVersion: accessVersion },
    }),
    400,
    "COLLAB_OWNER_INVALID",
    "所有权转移拒绝当前 owner 作为新 owner",
  );
  expectError(
    await admin.request(`/api/collab/documents/${ownershipDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: "no-such-member", expectedAccessVersion: accessVersion },
    }),
    400,
    "COLLAB_OWNER_INVALID",
    "所有权转移拒绝不存在的成员",
  );
  expectError(
    await admin.request(`/api/collab/documents/${ownershipDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: memberIds.outsider, expectedAccessVersion: accessVersion },
    }),
    403,
    "COLLAB_OWNER_OUT_OF_SCOPE",
    "所有权转移拒绝组织外成员",
  );
  expectError(
    await editor.request(`/api/collab/documents/${ownershipDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: memberIds.viewer, expectedAccessVersion: accessVersion },
    }),
    403,
    ["COLLAB_SHARE_DENIED", "FORBIDDEN"],
    "非 owner 不能转移文档所有权",
  );

  const transferred = dataOf(await expectStatus(
    admin.request(`/api/collab/documents/${ownershipDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: memberIds.editor, expectedAccessVersion: accessVersion },
    }),
    200,
    "管理员转移文档所有权给企业内有效成员",
  ));
  assert.equal(transferred.ownerUserId, memberIds.editor);
  assert.equal(transferred.createdBy, ownershipDocument.createdBy);
  assert.equal(transferred.createdByName, ownershipDocument.createdByName);
  assert.equal(transferred.ownerName, editor.userName || "协同回归editor");
  assert.equal(transferred.accessVersion, accessVersion + 1);
  assertDocumentMetadata(transferred, "所有权转移结果文档");
  pass("所有权转移不改变创建者并递增 accessVersion");

  const transferredMembers = dataOf(await expectStatus(
    admin.request(`/api/collab/documents/${ownershipDocument.id}/members`),
    200,
    "读取所有权转移后的成员 ACL",
  ));
  const previousOwner = transferredMembers.members.find((member) => member.userId === admin.userId);
  const newOwner = transferredMembers.members.find((member) => member.userId === memberIds.editor);
  assert.equal(previousOwner?.role, "editor");
  assert.equal(previousOwner?.status, "active");
  assert.equal(newOwner?.role, "owner");
  assert.equal(newOwner?.status, "active");
  pass("原所有者降级为 editor、新所有者成为 owner 且均保持 active");

  const newOwnerDetail = dataOf(await expectStatus(
    editor.request(`/api/collab/documents/${ownershipDocument.id}`),
    200,
    "新所有者读取文档",
  ));
  assert.equal(newOwnerDetail.permission.role, "owner");
  assert.equal(newOwnerDetail.permission.canEdit, true);
  pass("新所有者立即获得编辑权限");

  expectError(
    await admin.request(`/api/collab/documents/${ownershipDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: memberIds.viewer, expectedAccessVersion: accessVersion },
    }),
    409,
    "COLLAB_ACCESS_VERSION_CONFLICT",
    "所有权转移拒绝旧 accessVersion 覆盖",
  );

  const audit = await queryCollab(
    `SELECT action, metadata
       FROM collab.document_audit_events
      WHERE document_id = $1::uuid AND action = 'owner.transferred'
      ORDER BY id DESC
      LIMIT 1`,
    [ownershipDocument.id],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].metadata?.newOwnerUserId, memberIds.editor);
  assert.equal(audit.rows[0].metadata?.previousOwnerUserId, admin.userId);
  pass("所有权转移写入不含文件内容的审计事件");
}

/**
 * 验证文档列表、详情、编辑器降级、版本、ACL、文件和安全边界。
 * @param {{admin: ApiClient, editor: ApiClient, commenter: ApiClient, viewer: ApiClient, unshared: ApiClient, outsider: ApiClient, organizations: {inScopeId: string, outOfScopeId: string}, documents: string[]}} context 测试会话和资源上下文。
 * @returns {Promise<void>} 所有协同回归用例通过后兑现，并更新 documents 数组。
 * @throws {AssertionError|Error} 任意功能或权限边界不符合设计时抛出。
 */
async function runCollabRegression(context) {
  const { admin, editor, commenter, viewer, unshared, outsider, organizations, documents } = context;

  const unauthenticated = new ApiClient("unauthenticated");
  const anonymousList = await unauthenticated.request("/api/collab/documents");
  expectError(anonymousList, 401, "UNAUTHORIZED", "未登录不能读取协同文档");

  const badOrigin = await admin.request("/api/collab/documents", { origin: "http://evil.invalid" });
  expectError(badOrigin, 403, "FORBIDDEN", "不受信来源不能访问协同 API");

  const missingCsrf = await admin.request("/api/collab/documents", {
    method: "POST",
    body: { name: `协同回归缺少 CSRF-${testSuffix}` },
    csrf: false,
  });
  expectError(missingCsrf, 403, "FORBIDDEN", "写入接口必须携带 CSRF");

  const invalidName = await admin.request("/api/collab/documents", {
    method: "POST",
    body: { name: "../不允许的路径" },
  });
  expectError(invalidName, 400, "BAD_REQUEST", "文档名称拒绝路径穿越字符");

  const documentResponse = await expectStatus(
    admin.request("/api/collab/documents", {
      method: "POST",
      body: {
        name: `协同回归指定成员-${testSuffix}`,
        accessMode: "members",
        organizationId: organizations.inScopeId,
        allowDownload: false,
      },
    }),
    201,
    "管理员创建指定成员文档",
  );
  const document = dataOf(documentResponse);
  documents.push(document.id);
  assert.equal(document.accessMode, "members");
  assert.equal(document.allowDownload, false);
  assert.equal(document.storageLimitBytes, null);
  assert.equal(document.storageUsedBytes, document.fileSizeBytes);
  assert.equal(document.permission.role, "admin");
  assert.equal(document.permission.canEdit, true);
  assert.equal(document.permission.canShare, true);
  pass("创建文档默认禁止下载并返回管理员权限");
  assertDocumentMetadata(document, "管理员创建文档详情");
  const createdList = dataOf(await expectStatus(
    admin.request(`/api/collab/documents?page=1&pageSize=20&status=active&keyword=${encodeURIComponent(document.name)}`),
    200,
    "管理员读取文档列表元数据",
  ));
  const listedDocument = createdList.documents.find((item) => item.id === document.id);
  assert.ok(listedDocument, "created document appears in list");
  assertDocumentMetadata(listedDocument, "管理员文档列表");
  assert.equal(listedDocument.createdByName, document.createdByName);
  assert.equal(listedDocument.createdAt, document.createdAt);
  assert.equal(listedDocument.updatedAt, document.updatedAt);
  assert.equal(listedDocument.fileSizeBytes, document.fileSizeBytes);
  pass("文档列表与详情的创建者、时间和文件大小字段一致");

  const detail = await expectStatus(admin.request(`/api/collab/documents/${document.id}`), 200, "管理员读取文档详情");
  assert.equal(dataOf(detail).currentVersionId, document.currentVersionId);
  const officeConfig = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}/editor-config`),
    200,
    "读取编辑器配置降级状态",
  );
  const editorState = dataOf(officeConfig).editor;
  assert.equal(typeof editorState.available, "boolean");
  if (!editorState.available) {
    assert.match(String(editorState.message || ""), /ONLYOFFICE|编辑器|部署/);
    pass("未部署 ONLYOFFICE 时明确显示安全降级文案");
  } else {
    assert.ok(editorState.config && editorState.token, "configured office editor payload");
    const configuredEditor = editorState.config.editorConfig;
    assert.equal(configuredEditor?.lang, "zh", "ONLYOFFICE editor language");
    assert.equal(configuredEditor?.region, "zh-CN", "ONLYOFFICE editor region");
    assert.equal(configuredEditor?.coEditing?.mode, "fast", "ONLYOFFICE fast co-editing");
    assert.equal(configuredEditor?.coEditing?.change, false, "ONLYOFFICE co-editing mode is fixed");
    assert.equal(typeof configuredEditor?.user?.name, "string");
    assert.ok(configuredEditor.user.name.length > 0, "ONLYOFFICE collaborator name");
    pass("已配置 ONLYOFFICE 时返回中文界面、姓名选区提示和签名编辑器配置");
  }

  const initialVersions = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}/versions`),
    200,
    "管理员读取初始版本历史",
  );
  assert.equal(dataOf(initialVersions).versions.length, 1);
  const namedVersion = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}/versions`, {
      method: "POST",
      body: { label: `回归命名版本-${testSuffix}` },
    }),
    201,
    "管理员创建命名版本",
  );
  const namedVersionId = dataOf(namedVersion).id;
  const restoreVersion = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}/versions/${namedVersionId}/restore`, { method: "POST" }),
    200,
    "管理员恢复历史版本",
  );
  assert.equal(dataOf(restoreVersion).document.id, document.id);
  assert.ok(dataOf(restoreVersion).document.currentRevision > document.currentRevision);

  const baselineStorageBytes = Number(dataOf(restoreVersion).document.storageUsedBytes);
  const configuredStorageLimitBytes = (Math.ceil(baselineStorageBytes / 1024) + 2) * 1024;
  const configuredStorage = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}`, {
      method: "PATCH",
      body: { storageLimit: { value: configuredStorageLimitBytes / 1024, unit: "KB" } },
    }),
    200,
    "管理员设置文档 KB 容量上限",
  );
  assert.equal(dataOf(configuredStorage).storageLimitBytes, configuredStorageLimitBytes);
  assert.ok(dataOf(configuredStorage).storageUsedBytes <= configuredStorageLimitBytes);
  pass("文档详情返回当前占用和容量上限");
  if (baselineStorageBytes > 1024) {
    expectError(
      await admin.request(`/api/collab/documents/${document.id}`, {
        method: "PATCH",
        body: { storageLimit: { value: 1, unit: "KB" } },
      }),
      413,
      "COLLAB_STORAGE_LIMIT_EXCEEDED",
      "容量上限不能低于当前占用",
    );
  }

  const noDownloadExport = await admin.request(`/api/collab/documents/${document.id}/export`);
  expectError(noDownloadExport, 403, "COLLAB_EXPORT_DENIED", "文档关闭下载时拒绝导出");

  const downloadEnabled = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}`, { method: "PATCH", body: { allowDownload: true } }),
    200,
    "管理员打开文档下载开关",
  );
  const accessVersionBeforeMembers = dataOf(downloadEnabled).accessVersion;
  const xlsxExport = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}/export`),
    200,
    "管理员导出 xlsx 工作簿",
  );
  assert.ok(xlsxExport.bytes?.length > 4);
  assert.match(String(xlsxExport.headers.get("content-type") || ""), /spreadsheetml\.sheet/i);
  pass("导出返回受控 xlsx MIME 和非空内容");

  const memberSave = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}/members`, {
      method: "PUT",
      body: {
        expectedAccessVersion: accessVersionBeforeMembers,
        members: [
          { userId: context.memberIds.editor, role: "editor", canDownload: true },
          { userId: context.memberIds.commenter, role: "commenter", canDownload: true },
          { userId: context.memberIds.viewer, role: "viewer", canDownload: false },
        ],
      },
    }),
    200,
    "管理员保存成员 ACL",
  );
  const memberState = dataOf(memberSave);
  assert.equal(memberState.members.length, 4);
  const currentAccessVersion = memberState.accessVersion;

  await runOwnershipTransferRegression(context);

  const staleMembers = await admin.request(`/api/collab/documents/${document.id}/members`, {
    method: "PUT",
    body: { expectedAccessVersion: accessVersionBeforeMembers, members: [] },
  });
  expectError(staleMembers, 409, "COLLAB_ACCESS_VERSION_CONFLICT", "成员 ACL 乐观锁拒绝旧版本覆盖");
  const memberList = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}/members`),
    200,
    "管理员读取成员 ACL",
  );
  assert.equal(dataOf(memberList).accessVersion, currentAccessVersion);

  const editorDetail = await expectStatus(editor.request(`/api/collab/documents/${document.id}`), 200, "编辑者读取指定成员文档");
  assert.equal(dataOf(editorDetail).permission.role, "editor");
  assert.equal(dataOf(editorDetail).permission.canEdit, true);
  assert.equal(dataOf(editorDetail).permission.canExport, true);
  const editorMembers = await editor.request(`/api/collab/documents/${document.id}/members`);
  expectError(editorMembers, 403, ["COLLAB_SHARE_DENIED", "FORBIDDEN"], "编辑者不能枚举分享配置");
  await expectStatus(editor.request(`/api/collab/documents/${document.id}/versions`), 200, "编辑者读取版本历史");
  await expectStatus(
    editor.request(`/api/collab/documents/${document.id}/versions`, { method: "POST", body: { label: `编辑者版本-${testSuffix}` } }),
    201,
    "编辑者创建版本",
  );
  const editorExport = await expectStatus(editor.request(`/api/collab/documents/${document.id}/export`), 200, "编辑者按 ACL 导出工作簿");
  assert.ok(editorExport.bytes?.length > 4);
  expectError(
    await editor.request(`/api/collab/documents/${document.id}/import`, {
      method: "POST",
      form: fileForm(Buffer.alloc(configuredStorageLimitBytes + 1, 97), "超出容量.csv", "text/csv"),
    }),
    413,
    "COLLAB_STORAGE_LIMIT_EXCEEDED",
    "容量上限拒绝超限导入",
  );
  const clearedStorage = await expectStatus(
    admin.request(`/api/collab/documents/${document.id}`, { method: "PATCH", body: { storageLimit: null } }),
    200,
    "管理员清除文档容量上限",
  );
  assert.equal(dataOf(clearedStorage).storageLimitBytes, null);
  await expectStatus(
    editor.request(`/api/collab/documents/${document.id}/import`, {
      method: "POST",
      form: fileForm(xlsxExport.bytes, "回归导出.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    }),
    200,
    "编辑者导入合法 xlsx",
  );
  const invalidXlsx = await editor.request(`/api/collab/documents/${document.id}/import`, {
    method: "POST",
    form: fileForm(Buffer.from("not-an-xlsx"), "伪造.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
  });
  expectError(invalidXlsx, 400, "COLLAB_IMPORT_REJECTED", "导入拒绝伪造 xlsx 文件头");
  const invalidCsv = await editor.request(`/api/collab/documents/${document.id}/import`, {
    method: "POST",
    form: fileForm(Buffer.from([0, 1, 2]), "二进制.csv", "text/csv"),
  });
  expectError(invalidCsv, 400, "COLLAB_IMPORT_REJECTED", "导入拒绝包含二进制内容的 CSV");

  const activity = dataOf(await expectStatus(
    admin.request(`/api/collab/documents/${document.id}/activity?page=1&pageSize=100`),
    200,
    "管理员读取文档修改记录",
  ));
  const activityActions = new Set(activity.events.map((event) => event.action));
  for (const action of ["document.created", "document.updated", "document.exported", "document.imported", "version.created", "version.restored", "members.updated"]) {
    assert.ok(activityActions.has(action), `activity contains ${action}`);
  }
  assert.ok(activity.events.every((event) => event.id && event.actorName && event.createdAt));
  assert.doesNotMatch(JSON.stringify(activity), /object_key|source_object_key|token|password/i);
  pass("修改记录覆盖保存、导入、版本、导出和设置变更且不泄露文件路径");

  const commenterDetail = await expectStatus(commenter.request(`/api/collab/documents/${document.id}`), 200, "评论者读取指定成员文档");
  assert.equal(dataOf(commenterDetail).permission.canRead, true);
  assert.equal(dataOf(commenterDetail).permission.canComment, true);
  assert.equal(dataOf(commenterDetail).permission.canEdit, false);
  assert.equal(dataOf(commenterDetail).permission.canExport, false);
  const commenterVersion = await commenter.request(`/api/collab/documents/${document.id}/versions`, { method: "POST", body: { label: "不应创建" } });
  expectError(commenterVersion, 403, "COLLAB_EDIT_DENIED", "评论者不能创建版本");
  const commenterImport = await commenter.request(`/api/collab/documents/${document.id}/import`, {
    method: "POST",
    form: fileForm("a,b\n1,2\n", "评论者.csv", "text/csv"),
  });
  expectError(commenterImport, 403, ["COLLAB_EDIT_DENIED", "FORBIDDEN"], "评论者不能导入文件");
  const commenterExport = await commenter.request(`/api/collab/documents/${document.id}/export`);
  expectError(commenterExport, 403, ["COLLAB_EXPORT_DENIED", "FORBIDDEN"], "评论者不能导出文件");

  const viewerDetail = await expectStatus(viewer.request(`/api/collab/documents/${document.id}`), 200, "查看者读取指定成员文档");
  assert.equal(dataOf(viewerDetail).permission.role, "viewer");
  assert.equal(dataOf(viewerDetail).permission.canEdit, false);
  assert.equal(dataOf(viewerDetail).permission.canComment, false);
  assert.equal(dataOf(viewerDetail).permission.canExport, false);
  await expectStatus(viewer.request(`/api/collab/documents/${document.id}/versions`), 200, "查看者读取版本历史");
  const viewerVersion = await viewer.request(`/api/collab/documents/${document.id}/versions`, { method: "POST", body: { label: "不应创建" } });
  expectError(viewerVersion, 403, "COLLAB_EDIT_DENIED", "查看者不能创建版本");
  const viewerExport = await viewer.request(`/api/collab/documents/${document.id}/export`);
  expectError(viewerExport, 403, ["COLLAB_EXPORT_DENIED", "FORBIDDEN"], "查看者不能导出文件");

  const unsharedList = await expectStatus(unshared.request("/api/collab/documents"), 200, "未分享成员读取自己的文档列表");
  assert.equal(dataOf(unsharedList).documents.some((item) => item.id === document.id), false);
  const unsharedDetail = await unshared.request(`/api/collab/documents/${document.id}`);
  expectError(unsharedDetail, 403, "COLLAB_ACCESS_DENIED", "未分享成员不能读取指定成员文档");

  const outsiderDetail = await outsider.request(`/api/collab/documents/${document.id}`);
  expectError(outsiderDetail, 403, "COLLAB_ACCESS_DENIED", "组织外成员不能读取组织范围文档");

  const publicResponse = await expectStatus(
    admin.request("/api/collab/documents", {
      method: "POST",
      body: {
        name: `协同回归企业内公开-${testSuffix}`,
        accessMode: "company_public",
        organizationId: organizations.inScopeId,
        allowDownload: true,
      },
    }),
    201,
    "管理员创建企业内公开文档",
  );
  const publicDocument = dataOf(publicResponse);
  documents.push(publicDocument.id);
  const publicViewer = await expectStatus(viewer.request(`/api/collab/documents/${publicDocument.id}`), 200, "组织内成员读取企业内公开文档");
  assert.equal(dataOf(publicViewer).permission.canRead, true);
  assert.equal(dataOf(publicViewer).permission.canEdit, false);
  assert.equal(dataOf(publicViewer).permission.canExport, false);
  const publicViewerExport = await viewer.request(`/api/collab/documents/${publicDocument.id}/export`);
  expectError(publicViewerExport, 403, "COLLAB_EXPORT_DENIED", "企业内公开文档不会因允许下载自动授予成员导出权");
  const publicOutsider = await outsider.request(`/api/collab/documents/${publicDocument.id}`);
  expectError(publicOutsider, 403, "COLLAB_ACCESS_DENIED", "组织外成员不能读取企业内公开文档");

  const publicAccessVersion = dataOf(publicResponse).accessVersion;
  await expectStatus(
    admin.request(`/api/collab/documents/${publicDocument.id}/access`, {
      method: "PATCH",
      body: { accessMode: "members", organizationId: organizations.inScopeId, expectedAccessVersion: publicAccessVersion },
    }),
    200,
    "管理员切换企业内公开为指定成员",
  );
  const staleAccess = await admin.request(`/api/collab/documents/${publicDocument.id}/access`, {
    method: "PATCH",
    body: { accessMode: "company_public", organizationId: organizations.inScopeId, expectedAccessVersion: publicAccessVersion },
  });
  expectError(staleAccess, 409, "COLLAB_ACCESS_VERSION_CONFLICT", "访问模式切换拒绝旧版本覆盖");
  const hiddenViewer = await viewer.request(`/api/collab/documents/${publicDocument.id}`);
  expectError(hiddenViewer, 403, "COLLAB_ACCESS_DENIED", "切换指定成员后公开成员失去访问");
  const publicAgain = await expectStatus(
    admin.request(`/api/collab/documents/${publicDocument.id}/access`, {
      method: "PATCH",
      body: { accessMode: "company_public", organizationId: organizations.inScopeId, expectedAccessVersion: publicAccessVersion + 1 },
    }),
    200,
    "管理员恢复企业内公开访问",
  );
  assert.equal(dataOf(publicAgain).accessMode, "company_public");

  await expectStatus(
    admin.request(`/api/collab/documents/${document.id}`, { method: "PATCH", body: { status: "archived" } }),
    200,
    "管理员归档指定成员文档",
  );
  const archivedExport = await admin.request(`/api/collab/documents/${document.id}/export`);
  expectError(archivedExport, 403, "COLLAB_EXPORT_DENIED", "归档文档不能导出");
  await expectStatus(
    admin.request(`/api/collab/documents/${document.id}`, { method: "PATCH", body: { status: "active" } }),
    200,
    "管理员恢复归档文档",
  );
  await expectStatus(admin.request(`/api/collab/documents/${document.id}`, { method: "DELETE" }), 204, "管理员软删除指定成员文档");
  const deletedList = await expectStatus(admin.request("/api/collab/documents?status=deleted"), 200, "管理员读取软删除文档列表");
  assert.ok(dataOf(deletedList).documents.some((item) => item.id === document.id));
  const deletedDetail = await admin.request(`/api/collab/documents/${document.id}`);
  expectError(deletedDetail, 404, ["COLLAB_DOCUMENT_NOT_FOUND", "NOT_FOUND"], "软删除文档默认不再出现在详情");
  await expectStatus(admin.request(`/api/collab/documents/${document.id}/restore`, { method: "POST" }), 200, "管理员恢复软删除文档");
  pass("文档归档、软删除、恢复和版本保留流程通过");

  const officeFileWithoutToken = await admin.request(`/api/collab/office/files/${publicDocument.id}`);
  expectError(officeFileWithoutToken, 401, "UNAUTHORIZED", "Office 文件接口拒绝无令牌请求");
  const officeCallbackWithoutToken = await admin.request(`/api/collab/office/callback/${publicDocument.id}`, {
    method: "POST",
    body: { status: 1 },
  });
  expectError(officeCallbackWithoutToken, 401, "UNAUTHORIZED", "Office 回调接口拒绝无令牌请求");
}

/**
 * 将临时文档置为软删除、停用临时成员并解除岗位引用，最后删除临时岗位。
 * @param {{admin: ApiClient, documents: string[], members: Array<{id: string}>, positions: Record<string, string>}} context 测试资源上下文。
 * @returns {Promise<void>} 清理请求完成后兑现；单个清理失败会继续尝试其他资源并在最后抛出汇总错误。
 * @throws {Error} 关键测试资源清理失败时抛出，避免静默遗留可用测试账号。
 */
async function cleanupTestResources(context) {
  const errors = [];
  for (const documentId of [...new Set(context.documents)]) {
    try {
      const response = await context.admin.request(`/api/collab/documents/${documentId}`, { method: "DELETE" });
      if (![204, 404].includes(response.status)) errors.push(`document:${response.status}`);
    } catch (error) {
      errors.push(`document:${error.message}`);
    }
  }
  for (const member of context.members) {
    try {
      const response = await context.admin.request(`/api/organization/members/${member.id}`, {
        method: "PUT",
        body: { roleId: null, isDelete: true },
      });
      if (response.status !== 200) errors.push(`member:${response.status}`);
    } catch (error) {
      errors.push(`member:${error.message}`);
    }
  }
  for (const positionId of Object.values(context.positions || {})) {
    try {
      const response = await context.admin.request(`/api/positions/${positionId}`, { method: "DELETE" });
      if (![204, 404].includes(response.status)) errors.push(`position:${response.status}`);
    } catch (error) {
      errors.push(`position:${error.message}`);
    }
  }
  if (errors.length) throw new Error(`测试数据清理失败：${errors.join(", ")}`);
  pass("测试账号已停用、岗位已删除、测试文档已软删除");
}

/**
 * 构建测试上下文、执行回归和 finally 清理，主流程不输出任何敏感环境变量。
 * @returns {Promise<void>} 所有测试和清理完成后兑现。
 * @throws {Error} 测试或清理失败时设置非零进程退出码。
 */
async function main() {
  assert.ok(administratorUsername && administratorPassword, "INITIAL_ADMIN_USERNAME/PASSWORD are required");
  const context = {
    admin: null,
    editor: null,
    commenter: null,
    viewer: null,
    unshared: null,
    outsider: null,
    organizations: null,
    positions: {},
    members: [],
    memberIds: {},
    documents: [],
  };

  try {
    context.admin = await login(administratorUsername, administratorPassword, "管理员");
    context.organizations = await createTestOrganizations(context.admin);
    const positionState = await createTestPositions(context.admin);
    context.positions = positionState.positions;
    const memberDefinitions = [
      ["editor", context.organizations.inScopeId],
      ["commenter", context.organizations.inScopeId],
      ["viewer", context.organizations.inScopeId],
      ["unshared", context.organizations.inScopeId],
      ["outsider", context.organizations.outOfScopeId],
    ];
    for (const [roleName, organizationId] of memberDefinitions) {
      const member = await createTestMember(context.admin, context.positions[roleName === "unshared" || roleName === "outsider" ? "viewer" : roleName], organizationId, roleName);
      context.members.push(member);
      context.memberIds[roleName] = member.id;
    }
    context.editor = await login(
      `collabqa_${testSuffix}_editor`,
      `CollabQA-${testSuffix}-Password!`,
      "编辑者",
    );
    context.commenter = await login(
      `collabqa_${testSuffix}_commenter`,
      `CollabQA-${testSuffix}-Password!`,
      "评论者",
    );
    context.viewer = await login(
      `collabqa_${testSuffix}_viewer`,
      `CollabQA-${testSuffix}-Password!`,
      "查看者",
    );
    context.unshared = await login(
      `collabqa_${testSuffix}_unshared`,
      `CollabQA-${testSuffix}-Password!`,
      "未分享成员",
    );
    context.outsider = await login(
      `collabqa_${testSuffix}_outsider`,
      `CollabQA-${testSuffix}-Password!`,
      "组织外成员",
    );

    await runCollabRegression(context);
    console.log(`COLLAB_REGRESSION_PASS total=${passed}`);
  } finally {
    if (context.admin) {
      await cleanupTestResources(context).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`COLLAB_REGRESSION_FAIL ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ApiClient,
  dataOf,
  pass,
  expectStatus,
  expectError,
  login,
  fileForm,
  createTestPositions,
  createTestOrganizations,
  createTestMember,
  runCollabRegression,
  cleanupTestResources,
  getPassed: () => passed,
  testSuffix,
};
