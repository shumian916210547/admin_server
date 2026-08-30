"use strict";

/**
 * 按三个不同切入点执行在线协同表格的完整黑盒/白盒回归：业务流程、权限安全与数据边界、并发竞态与降级。
 * 本脚本复用公开 BFF 测试夹具，不直接写入 Parse 或 PostgreSQL；所有临时账号和文档在 finally 中清理。
 */

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { config } = require("../config/env");
const collabAccess = require("../services/collab-access.service");
const collabStorage = require("../services/collab-storage.service");
const {
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
  getPassed,
  testSuffix,
} = require("./collab-functional-test");

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

/**
 * 生成一个可供断言的 ZIP 文件，测试内容只用于验证 xlsx 条目安全检查，不作为业务文件输出。
 * @param {Array<{name: string, data?: Buffer|string, claimedUncompressedSize?: number}>} entries ZIP 条目及可选声明解压大小。
 * @returns {Buffer} 标准 ZIP 文件字节。
 */
function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    const claimedSize = entry.claimedUncompressedSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Math.min(claimedSize, 0xffffffff), 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Math.min(claimedSize, 0xffffffff), 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

/**
 * 返回最小合法 xlsx 条目集合，便于白盒测试文件头、中央目录和风险条目检查。
 * @param {Array<{name: string, data?: Buffer|string, claimedUncompressedSize?: number}>} [extraEntries=[]] 追加到合法工作簿的测试条目。
 * @returns {Buffer} 可被协同存储校验器识别的 ZIP 字节。
 */
function validXlsxBuffer(extraEntries = []) {
  return createStoredZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: "<workbook/>" },
    ...extraEntries,
  ]);
}

/**
 * 断言临时文件被协同文件校验器拒绝，并只输出安全的测试标签。
 * @param {string} directory 测试临时目录绝对路径。
 * @param {Buffer|string} content 待验证文件内容。
 * @param {string} fileName 模拟上传文件名。
 * @param {string} mimeType 模拟浏览器声明 MIME。
 * @param {string} label 测试标签。
 * @param {string|string[]} [codes="COLLAB_IMPORT_REJECTED"] 允许的错误码。
 * @returns {Promise<void>} 拒绝断言通过后兑现。
 * @throws {AssertionError} 文件未被拒绝或错误码不符合预期时抛出。
 */
async function expectFileRejected(directory, content, fileName, mimeType, label, codes = "COLLAB_IMPORT_REJECTED") {
  const filePath = path.join(directory, `${crypto.randomUUID()}.upload`);
  await fs.promises.writeFile(filePath, content);
  const expectedCodes = Array.isArray(codes) ? codes : [codes];
  await assert.rejects(
    () => collabStorage.validateSpreadsheetFile(filePath, fileName, mimeType),
    (error) => expectedCodes.includes(error?.code),
  );
  pass(label);
}

/**
 * 执行服务层、存储层、路由和前端容器的白盒不变量检查，覆盖输入规范化、路径安全、公式注入防护和实时能力边界。
 * @returns {Promise<void>} 所有白盒断言通过后兑现。
 * @throws {AssertionError|Error} 导出函数、源码结构或文件安全不变量不满足时抛出。
 */
async function runWhiteBoxChecks() {
  assert.ok(collabAccess.PAGE_ACTIONS.has("query"), "page query action is defined");
  assert.ok(collabAccess.PAGE_ACTIONS.has("history"), "page history action is defined");
  assert.equal(collabAccess.normalizeAccessMode(undefined), "members");
  assert.equal(collabAccess.normalizeBoolean(undefined, false), false);
  assert.equal(collabAccess.normalizeAccessVersion("2"), 2);
  assert.equal(collabAccess.normalizeDocumentId("550E8400-E29B-41D4-A716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(collabStorage.normalizeStorageLimit({ value: 2, unit: "KB" }), 2 * 1024);
  assert.equal(collabStorage.normalizeStorageLimit({ value: 1.5, unit: "MB" }), 1.5 * 1024 * 1024);
  assert.equal(collabStorage.normalizeStorageLimit(null), null);
  assert.equal(collabAccess.normalizeDocumentName("  白盒工作簿  "), "白盒工作簿");
  assert.throws(() => collabAccess.normalizeAccessMode("public"), /访问模式/);
  assert.throws(() => collabAccess.normalizeBoolean("false", false), /布尔/);
  assert.throws(() => collabAccess.normalizeAccessVersion(0), /正整数/);
  assert.throws(() => collabAccess.normalizeDocumentId("not-a-uuid"), /文档标识/);
  assert.throws(() => collabAccess.normalizeDocumentName("../unsafe"), /文档名称/);
  assert.throws(() => collabAccess.normalizeDocumentName("x".repeat(201)), /文档名称/);
  assert.throws(() => collabStorage.normalizeStorageLimit({ value: 0, unit: "MB" }), /正数/);
  assert.throws(() => collabStorage.normalizeStorageLimit({ value: 1, unit: "TB" }), /单位/);
  assert.throws(() => collabStorage.assertDocumentFileSizeWithinLimit(1024, 1025), /超过当前文档容量上限/);
  pass("C2-WB 服务层输入规范化和 ACL 白名单不变量");

  const objectKey = collabStorage.createObjectKey(crypto.randomUUID(), "xlsx", "sources");
  assert.match(objectKey, /^documents\/[a-f0-9-]+\/sources\/[a-f0-9-]+\.xlsx$/i);
  assert.throws(() => collabStorage.normalizeObjectKey("documents/../../outside.xlsx"), /对象键/);
  assert.throws(() => collabStorage.createObjectKey(crypto.randomUUID(), "exe"), /对象键/);
  pass("C2-WB 随机对象键和存储路径边界");

  const workspaceRoot = path.resolve(__dirname, "../..");
  const routeSource = await fs.promises.readFile(path.join(workspaceRoot, "admin_server/routes/api/index.js"), "utf8");
  const documentSource = await fs.promises.readFile(path.join(workspaceRoot, "admin_server/services/collab-document.service.js"), "utf8");
  const accessSource = await fs.promises.readFile(path.join(workspaceRoot, "admin_server/services/collab-access.service.js"), "utf8");
  const spreadsheetSource = await fs.promises.readFile(path.join(workspaceRoot, "vue_admin/src/views/collab/spreadsheet/index.vue"), "utf8");
  const editorSource = await fs.promises.readFile(path.join(workspaceRoot, "vue_admin/src/views/collab/spreadsheet/editor.vue"), "utf8");
  const spreadsheetServiceSource = await fs.promises.readFile(path.join(workspaceRoot, "vue_admin/src/service/collab-spreadsheet.service.js"), "utf8");
  const shareSource = await fs.promises.readFile(path.join(workspaceRoot, "vue_admin/src/components/collab/ShareDialog.vue"), "utf8");
  const shellSource = await fs.promises.readFile(path.join(workspaceRoot, "vue_admin/src/components/collab/SpreadsheetShell.vue"), "utf8");
  const officeSource = await fs.promises.readFile(path.join(workspaceRoot, "admin_server/services/collab-office.service.js"), "utf8");
  const csvSource = await fs.promises.readFile(path.join(workspaceRoot, "vue_admin/src/utils/csv.js"), "utf8");
  assert.match(routeSource, /router\.use\(authenticate\)/);
  assert.match(routeSource, /"\/collab\/documents"[\s\S]*?csrfGuard/);
  assert.match(documentSource, /withCollabTransaction\(async \(client\)/);
  assert.match(accessSource, /access_version = access_version \+ 1/);
  assert.match(accessSource, /async function transferDocumentOwnership/);
  assert.match(accessSource, /owner\.transferred/);
  assert.match(accessSource, /ORDER BY documents\.updated_at DESC, documents\.id DESC/);
  assert.match(spreadsheetSource, /row\.status === ['"]deleted['"]/);
  assert.match(spreadsheetSource, /createdByName/);
  assert.match(spreadsheetSource, /fileSizeBytes/);
  assert.doesNotMatch(spreadsheetSource, /SpreadsheetShell/);
  assert.match(editorSource, /SpreadsheetShell/);
  assert.match(editorSource, /collab-editor-page/);
  assert.match(spreadsheetServiceSource, /transferCollabDocumentOwnership/);
  assert.match(spreadsheetSource, /const canCreate = computed/);
  assert.match(shareSource, /originalMemberFingerprint/);
  assert.match(shareSource, /collab-share-dialog__ownership/);
  assert.match(routeSource, /transfer-ownership/);
  assert.match(shellSource, /onAppReady/);
  assert.match(shellSource, /悬停在其他成员的彩色选中单元格上即可查看成员姓名/);
  assert.match(officeSource, /lang: "zh"/);
  assert.match(officeSource, /region: "zh-CN"/);
  assert.match(officeSource, /coEditing: \{ mode: "fast", change: false \}/);
  assert.match(officeSource, /user: \{ id: auth\.userId, name:/);
  assert.match(csvSource, /Prevent spreadsheet formula injection/);
  assert.doesNotMatch(routeSource, /router\.(get|post|put|patch|delete)\(\s*["'`]\/collab\/ws/);
  pass("C2-WB BFF 认证/CSRF、事务锁、稳定排序与前端 UX 结构");

  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "collab-three-cycle-"));
  const validXlsxPath = path.join(tempDirectory, "valid.xlsx");
  const validXlsx = validXlsxBuffer();
  await fs.promises.writeFile(validXlsxPath, validXlsx);
  const xlsxSummary = await collabStorage.validateSpreadsheetFile(
    validXlsxPath,
    "合法工作簿.xlsx",
    collabStorage.XLSX_MIME_TYPE,
  );
  assert.equal(xlsxSummary.extension, "xlsx");
  const csvPath = path.join(tempDirectory, "valid.csv");
  await fs.promises.writeFile(csvPath, "name,value\nalpha,1\n", "utf8");
  const csvSummary = await collabStorage.validateSpreadsheetFile(csvPath, "合法数据.csv", "text/csv");
  assert.equal(csvSummary.extension, "csv");
  pass("C2-WB 合法 xlsx/CSV 文件格式校验");

  await expectFileRejected(tempDirectory, Buffer.from("not-xlsx"), "fake.xlsx", collabStorage.XLSX_MIME_TYPE, "C2-WB 拒绝伪造 xlsx 文件头");
  await expectFileRejected(tempDirectory, validXlsx, "mismatch.xlsx", "text/plain", "C2-WB 拒绝扩展名与 MIME 不匹配");
  await expectFileRejected(tempDirectory, validXlsxBuffer([{ name: "xl/vbaProject.bin", data: "macro" }]), "macro.xlsx", collabStorage.XLSX_MIME_TYPE, "C2-WB 拒绝宏文件条目");
  await expectFileRejected(tempDirectory, validXlsxBuffer([{ name: "xl/externalLinks/externalLink1.xml", data: "external" }]), "external.xlsx", collabStorage.XLSX_MIME_TYPE, "C2-WB 拒绝外部链接条目");
  await expectFileRejected(tempDirectory, validXlsxBuffer([{ name: "../outside.txt", data: "outside" }]), "traversal.xlsx", collabStorage.XLSX_MIME_TYPE, "C2-WB 拒绝 ZIP 路径穿越条目");
  await expectFileRejected(tempDirectory, createStoredZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: "<workbook/>" },
  ]), "duplicate.xlsx", collabStorage.XLSX_MIME_TYPE, "C2-WB 拒绝重复 ZIP 条目");
  await expectFileRejected(tempDirectory, validXlsxBuffer([{ name: "xl/sharedStrings.xml", data: "x", claimedUncompressedSize: 0xffffffff }]), "bomb.xlsx", collabStorage.XLSX_MIME_TYPE, "C2-WB 拒绝超限 ZIP 解压声明");
  await expectFileRejected(tempDirectory, Buffer.from([0, 1, 2]), "binary.csv", "text/csv", "C2-WB 拒绝二进制 CSV");
  pass("C2-WB xlsx 压缩包宏、外链、路径穿越、重复条目和 ZIP Bomb 防护");

  const stored = await collabStorage.storeUploadedFile(
    validXlsxPath,
    "../原始路径不进入对象键.xlsx",
    collabStorage.XLSX_MIME_TYPE,
    crypto.randomUUID(),
  );
  assert.doesNotMatch(stored.objectKey, /原始路径|\.\./);
  await collabStorage.removeObject(stored.objectKey);
  await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  pass("C2-WB 恶意原始文件名不进入随机对象键");
}

/**
 * 复制一个认证客户端的 Cookie/CSRF 状态，用于模拟同一用户的多个浏览器请求而不新增测试登录账号。
 * @param {ApiClient} source 已登录的源客户端。
 * @param {string} label 并发客户端标签。
 * @returns {ApiClient} 拥有独立可变响应状态的客户端副本。
 */
function cloneClient(source, label) {
  const client = new ApiClient(label);
  client.cookie = source.cookie;
  client.csrf = source.csrf;
  client.userId = source.userId;
  return client;
}

/**
 * 通过 BFF 创建测试文档并登记到统一清理列表。
 * @param {ApiClient} client 具有 insert/query 页面权限的客户端。
 * @param {Record<string, unknown>} payload 文档名称、访问模式、组织范围和下载开关。
 * @param {string[]} documents 测试上下文文档 ID 列表。
 * @param {string} label 黑盒用例标签。
 * @returns {Promise<Record<string, unknown>>} 新建文档 DTO。
 * @throws {AssertionError|Error} 创建失败时抛出。
 */
async function createTrackedDocument(client, payload, documents, label) {
  const response = await expectStatus(client.request("/api/collab/documents", { method: "POST", body: payload }), 201, label);
  const document = dataOf(response);
  assert.ok(document?.id, `${label} id`);
  documents.push(document.id);
  return document;
}

/**
 * 执行第二轮权限、安全、数据完整性、异常输入和账户资源生命周期测试。
 * @param {{admin: ApiClient, editor: ApiClient, commenter: ApiClient, viewer: ApiClient, unshared: ApiClient, outsider: ApiClient, organizations: {inScopeId: string, outOfScopeId: string}, positions: Record<string,string>, members: Array<{id:string}>, memberIds: Record<string,string>, documents: string[]}} context 三轮测试共享的认证与临时资源上下文。
 * @returns {Promise<void>} 第二轮所有黑盒与白盒测试通过后兑现。
 * @throws {AssertionError|Error} 任一权限、输入或数据边界不符合设计时抛出。
 */
async function runSecurityCycle(context) {
  const { admin, editor, commenter, unshared, outsider, organizations, positions, memberIds, documents } = context;
  await runWhiteBoxChecks();

  const sourceDocumentId = documents[0];
  const invalidListCases = [
    ["page=0", "C2-BB 列表拒绝 page=0"],
    ["pageSize=0", "C2-BB 列表拒绝 pageSize=0"],
    [`pageSize=${config.collab.maxListPageSize + 1}`, "C2-BB 列表拒绝超过上限的 pageSize"],
    ["status=unknown", "C2-BB 列表拒绝非法 status"],
    [`keyword=${encodeURIComponent("bad\u0001keyword")}`, "C2-BB 列表拒绝控制字符关键词"],
  ];
  for (const [query, label] of invalidListCases) {
    expectError(await admin.request(`/api/collab/documents?${query}`), 400, "BAD_REQUEST", label);
  }
  expectError(
    await admin.request("/api/collab/documents", {
      method: "POST",
      body: { name: "invalid-storage-limit", storageLimit: { value: 0, unit: "MB" } },
    }),
    400,
    "COLLAB_STORAGE_LIMIT_INVALID",
    "C2-BB 创建拒绝无效文档容量上限",
  );
  expectError(await admin.request("/api/collab/documents/not-a-uuid"), 400, "BAD_REQUEST", "C2-BB 详情拒绝非法文档 UUID");
  expectError(await admin.request(`/api/collab/documents/${crypto.randomUUID()}`), 404, "COLLAB_DOCUMENT_NOT_FOUND", "C2-BB 详情隐藏不存在文档");

  const invalidCreateCases = [
    [{ name: "invalid-mode", accessMode: "public" }, "C2-BB 创建拒绝非法访问模式"],
    [{ name: "invalid-bool", allowDownload: "true" }, "C2-BB 创建拒绝字符串下载开关"],
    [{ name: "x".repeat(201) }, "C2-BB 创建拒绝超长名称"],
    [{ name: "invalid-org", organizationId: "no-such-organization" }, "C2-BB 创建拒绝无效组织"],
  ];
  for (const [payload, label] of invalidCreateCases) {
    expectError(await admin.request("/api/collab/documents", { method: "POST", body: payload }), 400, ["BAD_REQUEST", "COLLAB_ORGANIZATION_INVALID"], label);
  }

  const spoofed = await createTrackedDocument(
    admin,
    {
      name: `C2 数据边界-${testSuffix}`,
      accessMode: "members",
      organizationId: organizations.inScopeId,
      allowDownload: false,
      companyId: "spoof-company",
      ownerUserId: "spoof-owner",
      owner_user_id: "spoof-owner-underscore",
      createdBy: "spoof-creator",
    },
    documents,
    "C2-BB 创建忽略客户端 company/owner/createdBy 字段",
  );
  assert.equal(spoofed.ownerUserId, admin.userId);
  assert.equal(spoofed.organizationId, organizations.inScopeId);
  pass("C2-BB 创建结果由服务端会话确定 owner");

  expectError(await admin.request(`/api/collab/documents/${spoofed.id}`, { method: "PATCH", body: {} }), 400, "BAD_REQUEST", "C2-BB 更新拒绝空字段");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}`, { method: "PATCH", body: { status: "deleted" } }), 400, "BAD_REQUEST", "C2-BB 更新不允许直接设置 deleted");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}`, { method: "PATCH", body: { status: "unknown" } }), 400, "BAD_REQUEST", "C2-BB 更新拒绝非法状态");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}`, { method: "PATCH", body: { allowDownload: "true" } }), 400, "BAD_REQUEST", "C2-BB 更新拒绝字符串下载开关");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/access`, { method: "PATCH", body: { accessMode: "company_public" } }), 400, "BAD_REQUEST", "C2-BB 访问模式修改要求乐观锁版本");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/access`, { method: "PATCH", body: { accessMode: "invalid", expectedAccessVersion: spoofed.accessVersion } }), 400, "BAD_REQUEST", "C2-BB 访问模式修改拒绝非法模式");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/access`, { method: "PATCH", body: { accessMode: "company_public", organizationId: "another-org", expectedAccessVersion: spoofed.accessVersion } }), 400, "COLLAB_ORGANIZATION_IMMUTABLE", "C2-BB 访问模式修改拒绝改变组织范围");

  const memberCases = [
    [{ members: "not-array", expectedAccessVersion: spoofed.accessVersion }, "C2-BB ACL 拒绝非数组成员列表"],
    [{ members: [{ userId: memberIds.editor, role: "viewer" }, { userId: memberIds.editor, role: "editor" }], expectedAccessVersion: spoofed.accessVersion }, "C2-BB ACL 拒绝重复成员"],
    [{ members: [{ userId: admin.userId, role: "viewer" }], expectedAccessVersion: spoofed.accessVersion }, "C2-BB ACL 拒绝重复授权 owner"],
    [{ members: [{ userId: memberIds.editor, role: "invalid" }], expectedAccessVersion: spoofed.accessVersion }, "C2-BB ACL 拒绝非法成员角色"],
    [{ members: [{ userId: memberIds.editor, role: "viewer", canDownload: "true" }], expectedAccessVersion: spoofed.accessVersion }, "C2-BB ACL 拒绝字符串成员下载权限"],
    [{ members: Array.from({ length: 101 }, (_, index) => ({ userId: `member-${index}`, role: "viewer" })), expectedAccessVersion: spoofed.accessVersion }, "C2-BB ACL 拒绝超过成员上限"],
  ];
  for (const [payload, label] of memberCases) {
    expectError(await admin.request(`/api/collab/documents/${spoofed.id}/members`, { method: "PUT", body: payload }), 400, "BAD_REQUEST", label);
  }
  expectError(
    await admin.request(`/api/collab/documents/${spoofed.id}/members`, {
      method: "PUT",
      body: { members: [{ userId: memberIds.outsider, role: "viewer" }], expectedAccessVersion: spoofed.accessVersion },
    }),
    403,
    "COLLAB_MEMBER_OUT_OF_SCOPE",
    "C2-BB ACL 拒绝组织外成员",
  );
  expectError(
    await commenter.request(`/api/collab/documents/${spoofed.id}/members`, { method: "PUT", body: { members: [], expectedAccessVersion: 1 } }),
    403,
    ["COLLAB_ACCESS_DENIED", "COLLAB_SHARE_DENIED", "FORBIDDEN"],
    "C2-BB 非 owner 不能保存 ACL",
  );
  expectError(await commenter.request(`/api/collab/documents/${spoofed.id}/member-options`), 403, ["COLLAB_ACCESS_DENIED", "COLLAB_SHARE_DENIED", "FORBIDDEN"], "C2-BB 非 owner 不能读取成员选项");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/members/${admin.userId}`, { method: "DELETE" }), 400, "COLLAB_OWNER_REQUIRED", "C2-BB ACL 保护 owner 不可移除");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/members/${crypto.randomUUID()}`, { method: "DELETE" }), 404, "COLLAB_MEMBER_NOT_FOUND", "C2-BB ACL 移除不存在成员返回稳定错误");

  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/versions`, { method: "POST", body: { label: "" } }), 400, "BAD_REQUEST", "C2-BB 版本拒绝空名称");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/versions`, { method: "POST", body: { label: "x".repeat(101) } }), 400, "BAD_REQUEST", "C2-BB 版本拒绝超长名称");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/versions`, { method: "POST", body: { label: "bad\u0001label" } }), 400, "BAD_REQUEST", "C2-BB 版本拒绝控制字符");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/versions/bad/restore`, { method: "POST" }), 400, "BAD_REQUEST", "C2-BB 恢复版本拒绝非法版本 UUID");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/versions/${crypto.randomUUID()}/restore`, { method: "POST" }), 404, "COLLAB_VERSION_NOT_FOUND", "C2-BB 恢复版本隐藏不存在版本");
  await expectStatus(admin.request(`/api/collab/documents/${spoofed.id}`, { method: "PATCH", body: { status: "archived" } }), 200, "C2-BB 归档文档");
  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/versions`, { method: "POST", body: { label: "归档中不应创建" } }), 403, ["COLLAB_EDIT_DENIED", "COLLAB_DOCUMENT_ARCHIVED"], "C2-BB 归档文档拒绝创建版本");
  await expectStatus(admin.request(`/api/collab/documents/${spoofed.id}`, { method: "PATCH", body: { status: "active" } }), 200, "C2-BB 恢复文档 active 状态");

  expectError(await admin.request(`/api/collab/documents/${spoofed.id}/import`, { method: "POST" }), 400, "BAD_REQUEST", "C2-BB 导入缺少文件返回可操作错误");
  expectError(
    await admin.request(`/api/collab/documents/${spoofed.id}/import`, { method: "POST", form: fileForm(Buffer.from("not-xlsx"), "wrong.xlsx", "text/plain") }),
    400,
    ["BAD_REQUEST", "COLLAB_IMPORT_REJECTED"],
    "C2-BB 导入拒绝上传 MIME 与扩展名不匹配",
  );

  const csvDocument = await createTrackedDocument(
    admin,
    { name: `C2 CSV-${testSuffix}`, accessMode: "members", organizationId: organizations.inScopeId, allowDownload: true },
    documents,
    "C2-BB 创建 CSV 导入文档",
  );
  const csvMembers = await expectStatus(
    admin.request(`/api/collab/documents/${csvDocument.id}/members`, {
      method: "PUT",
      body: { expectedAccessVersion: csvDocument.accessVersion, members: [{ userId: memberIds.editor, role: "editor", canDownload: true }] },
    }),
    200,
    "C2-BB 授权编辑者导入导出 CSV",
  );
  const csvAccessVersion = dataOf(csvMembers).accessVersion;
  assert.ok(csvAccessVersion > csvDocument.accessVersion);
  const csvContent = "name,value\nalpha,1\n";
  const csvImport = await expectStatus(
    editor.request(`/api/collab/documents/${csvDocument.id}/import`, { method: "POST", form: fileForm(csvContent, "业务数据.csv", "text/csv") }),
    200,
    "C2-BB 编辑者导入合法 CSV",
  );
  assert.equal(dataOf(csvImport).id, csvDocument.id);
  const csvExport = await expectStatus(editor.request(`/api/collab/documents/${csvDocument.id}/export`), 200, "C2-BB 编辑者导出 CSV");
  assert.match(String(csvExport.headers.get("content-type") || ""), /text\/csv/i);
  assert.match(String(csvExport.headers.get("content-disposition") || ""), /\.csv/i);
  assert.equal(csvExport.bytes.toString("utf8"), csvContent);
  pass("C2-BB CSV 导入后导出保持格式、内容和受控文件名");

  const detail = dataOf(await expectStatus(admin.request(`/api/collab/documents/${sourceDocumentId}`), 200, "C2-BB 读取文档安全 DTO"));
  const detailText = JSON.stringify(detail);
  for (const forbiddenField of ["sourceObjectKey", "source_object_key", "objectKey", "object_key", "company_id"]) {
    assert.equal(detailText.includes(forbiddenField), false, `DTO does not expose ${forbiddenField}`);
  }
  pass("C2-BB 文档 DTO 不泄露物理对象键和数据库字段");

  const genericBypass = await admin.request("/api/data/CollabDocument", { method: "POST", body: { attributes: { name: "bypass" } } });
  expectError(genericBypass, 404, ["NOT_FOUND", "BAD_REQUEST"], "C2-BB 通用 Parse CRUD 不能创建协同文档");

  const onlineSessions = await expectStatus(admin.request("/api/online-members"), 200, "C2-BB 管理员读取在线会话");
  assert.ok(Array.isArray(dataOf(onlineSessions).sessions));
  pass("C2-BB 在线会话列表返回脱敏数组");
  await expectStatus(admin.request(`/api/online-members/${memberIds.unshared}/force-logout`, { method: "POST" }), 200, "C2-BB 管理员强制下线临时成员");
  expectError(await unshared.request("/api/auth/session"), 401, "UNAUTHORIZED", "C2-BB 强制下线立即使旧会话失效");
  await expectStatus(admin.request(`/api/online-members/${memberIds.unshared}/freeze`, { method: "POST", body: { durationMinutes: 1 } }), 200, "C2-BB 管理员冻结临时成员");
  const frozenLogin = new ApiClient("frozen-member");
  expectError(
    await frozenLogin.request("/api/auth/login", { method: "POST", body: { username: `collabqa_${testSuffix}_unshared`, password: `CollabQA-${testSuffix}-Password!` }, csrf: false }),
    401,
    "UNAUTHORIZED",
    "C2-BB 冻结成员不能重新登录",
  );

  const overview = dataOf(await expectStatus(admin.request("/api/positions/overview"), 200, "C2-BB 读取岗位目录用于动态权限回归"));
  const route = overview.routes.find(
    (item) => item.systemKey === "collab.spreadsheet" || item.path === "spreadsheet" || item.pageComponent === "/collab/spreadsheet/index" || item.targetClass === "CollabDocument",
  );
  assert.ok(route?.objectId, "collab route for permission regression");
  await expectStatus(
    admin.request(`/api/positions/${positions.editor}`, {
      method: "PUT",
      body: { pagePermissions: [{ routeId: route.objectId, permissions: spreadsheetPermissions.filter((permission) => permission !== "permission:edit") }] },
    }),
    200,
    "C2-BB 移除编辑岗位的页面 edit 权限",
  );
  expectError(
    await editor.request(`/api/collab/documents/${sourceDocumentId}/versions`, { method: "POST", body: { label: "岗位权限已移除" } }),
    403,
    ["FORBIDDEN", "COLLAB_EDIT_DENIED"],
    "C2-BB 页面 edit 权限移除后服务端拒绝创建版本",
  );
  await expectStatus(
    admin.request(`/api/positions/${positions.editor}`, {
      method: "PUT",
      body: { pagePermissions: [{ routeId: route.objectId, permissions: spreadsheetPermissions }] },
    }),
    200,
    "C2-BB 恢复编辑岗位页面权限",
  );
}

/**
 * 执行第三轮并发、竞态、降级、性能边界和用户体验回归测试。
 * @param {{admin: ApiClient, editor: ApiClient, commenter: ApiClient, viewer: ApiClient, organizations: {inScopeId: string}, documents: string[], memberIds: Record<string,string>}} context 三轮测试共享的认证与临时资源上下文。
 * @returns {Promise<void>} 第三轮所有并发和阶段限制测试通过后兑现。
 * @throws {AssertionError|Error} 并发写入、状态生命周期、列表稳定性或降级边界不符合预期时抛出。
 */
async function runConcurrencyCycle(context) {
  const { admin, editor, commenter, viewer, organizations, documents, memberIds } = context;
  const adminA = cloneClient(admin, "管理员并发 A");
  const adminB = cloneClient(admin, "管理员并发 B");

  const raceDocument = await createTrackedDocument(
    admin,
    { name: `C3 并发文档-${testSuffix}`, accessMode: "members", organizationId: organizations.inScopeId, allowDownload: true },
    documents,
    "C3-BB 创建并发测试文档",
  );
  const initialAccessVersion = raceDocument.accessVersion;
  const accessResults = await Promise.all([
    adminA.request(`/api/collab/documents/${raceDocument.id}/access`, { method: "PATCH", body: { accessMode: "company_public", organizationId: organizations.inScopeId, expectedAccessVersion: initialAccessVersion } }),
    adminB.request(`/api/collab/documents/${raceDocument.id}/access`, { method: "PATCH", body: { accessMode: "company_public", organizationId: organizations.inScopeId, expectedAccessVersion: initialAccessVersion } }),
  ]);
  assert.equal(accessResults.filter((response) => response.status === 200).length, 1, "exactly one access update succeeds");
  assert.equal(accessResults.filter((response) => response.status === 409).length, 1, "one stale access update conflicts");
  const accessConflict = accessResults.find((response) => response.status === 409);
  assert.equal(accessConflict.body?.error?.code, "COLLAB_ACCESS_VERSION_CONFLICT");
  pass("C3-BB 同时切换公开模式只允许一个 accessVersion 成功");
  const publicState = dataOf(accessResults.find((response) => response.status === 200));
  assert.equal(publicState.accessMode, "company_public");
  assert.equal(publicState.accessVersion, initialAccessVersion + 1);
  pass("C3-BB 并发访问模式最终状态和版本单调");

  const ownershipRaceDocument = await createTrackedDocument(
    admin,
    { name: `C3 所有权并发-${testSuffix}`, accessMode: "members", organizationId: organizations.inScopeId, allowDownload: false },
    documents,
    "C3-BB 创建所有权并发文档",
  );
  const ownershipTransfers = await Promise.all([
    adminA.request(`/api/collab/documents/${ownershipRaceDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: memberIds.editor, expectedAccessVersion: ownershipRaceDocument.accessVersion },
    }),
    adminB.request(`/api/collab/documents/${ownershipRaceDocument.id}/transfer-ownership`, {
      method: "POST",
      body: { newOwnerUserId: memberIds.commenter, expectedAccessVersion: ownershipRaceDocument.accessVersion },
    }),
  ]);
  assert.equal(ownershipTransfers.filter((response) => response.status === 200).length, 1, "one ownership transfer succeeds");
  assert.equal(ownershipTransfers.filter((response) => response.status === 409).length, 1, "one concurrent ownership transfer conflicts");
  const ownershipSuccess = dataOf(ownershipTransfers.find((response) => response.status === 200));
  const ownershipConflict = ownershipTransfers.find((response) => response.status === 409);
  assert.equal(ownershipConflict.body?.error?.code, "COLLAB_ACCESS_VERSION_CONFLICT");
  const ownershipState = dataOf(await expectStatus(
    admin.request(`/api/collab/documents/${ownershipRaceDocument.id}`),
    200,
    "C3-BB 读取所有权并发最终文档",
  ));
  assert.equal(ownershipState.ownerUserId, ownershipSuccess.ownerUserId);
  assert.equal(ownershipState.accessVersion, ownershipRaceDocument.accessVersion + 1);
  const ownershipMembers = dataOf(await expectStatus(
    admin.request(`/api/collab/documents/${ownershipRaceDocument.id}/members`),
    200,
    "C3-BB 读取所有权并发最终 ACL",
  ));
  assert.equal(ownershipMembers.members.filter((member) => member.role === "owner" && member.status === "active").length, 1);
  pass("C3-BB 多用户同时转移所有权仅一个成功且无双 owner");

  const memberResults = await Promise.all([
    adminA.request(`/api/collab/documents/${raceDocument.id}/members`, { method: "PUT", body: { expectedAccessVersion: publicState.accessVersion, members: [{ userId: memberIds.editor, role: "editor", canDownload: true }] } }),
    adminB.request(`/api/collab/documents/${raceDocument.id}/members`, { method: "PUT", body: { expectedAccessVersion: publicState.accessVersion, members: [{ userId: memberIds.commenter, role: "commenter", canDownload: false }] } }),
  ]);
  assert.equal(memberResults.filter((response) => response.status === 200).length, 1, "exactly one members update succeeds");
  assert.equal(memberResults.filter((response) => response.status === 409).length, 1, "one stale members update conflicts");
  assert.equal(memberResults.find((response) => response.status === 409).body?.error?.code, "COLLAB_ACCESS_VERSION_CONFLICT");
  pass("C3-BB 同时保存成员 ACL 不发生后写覆盖");

  const memberState = dataOf(await expectStatus(admin.request(`/api/collab/documents/${raceDocument.id}/members`), 200, "C3-BB 读取并发 ACL 最终状态"));
  assert.equal(memberState.members.filter((member) => member.role !== "owner").length, 1);
  const completeMembers = await expectStatus(
    admin.request(`/api/collab/documents/${raceDocument.id}/members`, {
      method: "PUT",
      body: { expectedAccessVersion: memberState.accessVersion, members: [
        { userId: memberIds.editor, role: "editor", canDownload: true },
        { userId: memberIds.commenter, role: "commenter", canDownload: false },
        { userId: memberIds.viewer, role: "viewer", canDownload: false },
      ] },
    }),
    200,
    "C3-BB 设定并发文档完整成员 ACL",
  );
  assert.equal(dataOf(completeMembers).members.length, 4);

  const beforeVersions = dataOf(await expectStatus(admin.request(`/api/collab/documents/${raceDocument.id}/versions`), 200, "C3-BB 读取并发版本基线"));
  const versionCount = 8;
  const versionResults = await Promise.all(
    Array.from({ length: versionCount }, (_, index) => cloneClient(admin, `版本并发-${index}`).request(`/api/collab/documents/${raceDocument.id}/versions`, { method: "POST", body: { label: `并发命名版本-${index}-${testSuffix}` } })),
  );
  assert.ok(versionResults.every((response) => response.status === 201), "all concurrent version writes succeed");
  const versionNumbers = versionResults.map((response) => dataOf(response).versionNo).sort((left, right) => left - right);
  assert.equal(new Set(versionNumbers).size, versionCount, "concurrent version numbers are unique");
  assert.deepEqual(versionNumbers, Array.from({ length: versionCount }, (_, index) => beforeVersions.versions.length + index + 1));
  pass("C3-BB 并发创建命名版本保持唯一、连续且历史不丢失");
  const afterVersions = dataOf(await expectStatus(admin.request(`/api/collab/documents/${raceDocument.id}/versions`), 200, "C3-BB 读取并发版本结果"));
  assert.equal(afterVersions.versions.length, beforeVersions.versions.length + versionCount);
  assert.ok(versionResults.some((response) => dataOf(response).id === afterVersions.currentVersionId));
  pass("C3-BB 并发版本 currentVersionId 指向已持久化版本");

  const listStart = Date.now();
  const listResults = await Promise.all(
    Array.from({ length: 20 }, (_, index) => {
      const client = cloneClient(index % 2 ? admin : editor, `列表并发-${index}`);
      const query = `page=1&pageSize=20&status=active&keyword=${encodeURIComponent(raceDocument.name)}&sort=${index % 2 ? "updatedAt" : "unsupported"}`;
      const startedAt = Date.now();
      return client.request(`/api/collab/documents?${query}`).then((response) => ({ response, duration: Date.now() - startedAt }));
    }),
  );
  const listElapsed = Date.now() - listStart;
  assert.ok(listResults.every(({ response }) => response.status === 200), "concurrent filtered lists return 200");
  for (const { response } of listResults) {
    const result = dataOf(response);
    assert.ok(result.documents.every((document) => document.id === raceDocument.id), "keyword filter does not leak another document");
  }
  const firstIds = dataOf(listResults[0].response).documents.map((document) => document.id);
  const secondIds = dataOf(listResults[1].response).documents.map((document) => document.id);
  assert.deepEqual(firstIds, secondIds, "unknown sort input cannot change deterministic server ordering");
  const listDurations = listResults.map(({ duration }) => duration).sort((left, right) => left - right);
  const p95 = listDurations[Math.min(listDurations.length - 1, Math.ceil(listDurations.length * 0.95) - 1)];
  assert.ok(p95 < 10_000, `concurrent list p95 ${p95}ms remains within test safety bound`);
  console.log(`C3_METRIC concurrent_list_count=20 p95_ms=${p95} elapsed_ms=${listElapsed}`);
  pass("C3-BB 多用户同时筛选/排序参数请求保持隔离和稳定顺序");

  const exportAndRevoke = await Promise.all([
    editor.request(`/api/collab/documents/${raceDocument.id}/export`),
    adminA.request(`/api/collab/documents/${raceDocument.id}/members/${memberIds.editor}`, { method: "DELETE" }),
  ]);
  assert.equal(exportAndRevoke[1].status, 200, "member revoke succeeds during export race");
  assert.ok([200, 403].includes(exportAndRevoke[0].status), "export race has no server error");
  pass("C3-BB 并发导出与权限撤销无 5xx，撤销事务完成");
  const versionAfterRevoke = dataOf(await expectStatus(admin.request(`/api/collab/documents/${raceDocument.id}/members`), 200, "C3-BB 读取撤销后的 accessVersion"));
  const membersMode = await expectStatus(
    adminA.request(`/api/collab/documents/${raceDocument.id}/access`, { method: "PATCH", body: { accessMode: "members", organizationId: organizations.inScopeId, expectedAccessVersion: versionAfterRevoke.accessVersion } }),
    200,
    "C3-BB 权限撤销后切回指定成员模式",
  );
  assert.equal(dataOf(membersMode).accessMode, "members");
  expectError(await editor.request(`/api/collab/documents/${raceDocument.id}`), 403, "COLLAB_ACCESS_DENIED", "C3-BB 被移除成员不能继续读取文档");
  expectError(await editor.request(`/api/collab/documents/${raceDocument.id}/export`), 403, ["COLLAB_ACCESS_DENIED", "COLLAB_EXPORT_DENIED"], "C3-BB 被移除成员不能继续导出文档");

  const lifecycleDocument = await createTrackedDocument(
    admin,
    { name: `C3 生命周期-${testSuffix}`, accessMode: "members", organizationId: organizations.inScopeId, allowDownload: true },
    documents,
    "C3-BB 创建导入与归档竞态文档",
  );
  await expectStatus(
    admin.request(`/api/collab/documents/${lifecycleDocument.id}/members`, { method: "PUT", body: { expectedAccessVersion: lifecycleDocument.accessVersion, members: [{ userId: memberIds.editor, role: "editor", canDownload: true }] } }),
    200,
    "C3-BB 授权生命周期竞态编辑者",
  );
  const lifecycleExport = await expectStatus(admin.request(`/api/collab/documents/${lifecycleDocument.id}/export`), 200, "C3-BB 获取生命周期竞态文件基线");
  const importArchive = await Promise.all([
    editor.request(`/api/collab/documents/${lifecycleDocument.id}/import`, { method: "POST", form: fileForm(lifecycleExport.bytes, "lifecycle.xlsx", collabStorage.XLSX_MIME_TYPE) }),
    adminA.request(`/api/collab/documents/${lifecycleDocument.id}`, { method: "PATCH", body: { status: "archived" } }),
  ]);
  console.log(`C3_METRIC import_status=${importArchive[0].status} archive_status=${importArchive[1].status}`);
  assert.ok([200, 409].includes(importArchive[0].status), `import either commits before archive or conflicts safely (status=${importArchive[0].status})`);
  assert.equal(importArchive[1].status, 200, "archive succeeds during import race");
  pass("C3-BB 并发导入与归档只产生安全成功/冲突结果");
  const archivedLifecycle = dataOf(await expectStatus(admin.request(`/api/collab/documents/${lifecycleDocument.id}`), 200, "C3-BB 验证归档竞态最终状态"));
  assert.equal(archivedLifecycle.status, "archived");
  expectError(await admin.request(`/api/collab/documents/${lifecycleDocument.id}/export`), 403, "COLLAB_EXPORT_DENIED", "C3-BB 归档竞态最终禁止导出");
  await expectStatus(admin.request(`/api/collab/documents/${lifecycleDocument.id}`, { method: "PATCH", body: { status: "active" } }), 200, "C3-BB 恢复生命周期文档 active");

  const deleteRestoreDocument = await createTrackedDocument(
    admin,
    { name: `C3 删除恢复竞态-${testSuffix}`, accessMode: "members", organizationId: organizations.inScopeId, allowDownload: false },
    documents,
    "C3-BB 创建删除恢复竞态文档",
  );
  const deleteRestoreResults = await Promise.all([
    adminA.request(`/api/collab/documents/${deleteRestoreDocument.id}`, { method: "DELETE" }),
    adminB.request(`/api/collab/documents/${deleteRestoreDocument.id}/restore`, { method: "POST" }),
  ]);
  assert.equal(deleteRestoreResults[0].status, 204, "delete succeeds in delete/restore race");
  assert.ok([200, 409].includes(deleteRestoreResults[1].status), "restore race returns success or status conflict");
  pass("C3-BB 并发删除与恢复无脏状态或 5xx");
  const deleteRestoreDetail = await admin.request(`/api/collab/documents/${deleteRestoreDocument.id}`);
  if (deleteRestoreDetail.status === 404) {
    await expectStatus(admin.request(`/api/collab/documents/${deleteRestoreDocument.id}/restore`, { method: "POST" }), 200, "C3-BB 删除恢复竞态后的补偿恢复");
  } else {
    assert.equal(deleteRestoreDetail.status, 200);
  }
  const activeAfterRace = dataOf(await expectStatus(admin.request(`/api/collab/documents/${deleteRestoreDocument.id}`), 200, "C3-BB 删除恢复竞态最终 active 状态"));
  assert.equal(activeAfterRace.status, "active");

  const wsAttempt = await admin.request("/api/collab/ws");
  expectError(wsAttempt, 404, ["NOT_FOUND", "BAD_REQUEST"], "C3-BB 未部署 WebSocket 入口明确返回不可用");
  const operationAttempt = await admin.request(`/api/collab/documents/${raceDocument.id}/operations`, { method: "POST", body: { clientId: "fake", clientSequence: 1, baseRevision: 0, operationType: "cell.update", payload: { cell: "A1", value: "fake" } } });
  expectError(operationAttempt, 404, ["NOT_FOUND", "BAD_REQUEST"], "C3-BB 伪造单元格操作不能绕过未启用协议");
  const cellAttempt = await admin.request(`/api/collab/documents/${raceDocument.id}/cell/A1`);
  expectError(cellAttempt, 404, ["NOT_FOUND", "BAD_REQUEST"], "C3-BB 未启用单元格接口不暴露越权入口");
  pass("C3-BB 同单元格编辑/筛选排序实时能力按阶段限制安全降级");
}

/**
 * 创建多角色测试上下文、依次执行三轮测试并在最后清理账号、岗位和文档。
 * @returns {Promise<void>} 三轮全部通过并清理完成后兑现。
 * @throws {Error} 任一轮失败或清理失败时设置非零退出码。
 */
async function main() {
  const administratorUsername = process.env.INITIAL_ADMIN_USERNAME;
  const administratorPassword = process.env.INITIAL_ADMIN_PASSWORD;
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
      const member = await createTestMember(
        context.admin,
        context.positions[roleName === "unshared" || roleName === "outsider" ? "viewer" : roleName],
        organizationId,
        roleName,
      );
      context.members.push(member);
      context.memberIds[roleName] = member.id;
    }
    context.editor = await login(`collabqa_${testSuffix}_editor`, `CollabQA-${testSuffix}-Password!`, "编辑者");
    context.commenter = await login(`collabqa_${testSuffix}_commenter`, `CollabQA-${testSuffix}-Password!`, "评论者");
    context.viewer = await login(`collabqa_${testSuffix}_viewer`, `CollabQA-${testSuffix}-Password!`, "查看者");
    context.unshared = await login(`collabqa_${testSuffix}_unshared`, `CollabQA-${testSuffix}-Password!`, "未分享成员");
    context.outsider = await login(`collabqa_${testSuffix}_outsider`, `CollabQA-${testSuffix}-Password!`, "组织外成员");

    console.log("CYCLE_1_START business black-box and white-box regression");
    await runCollabRegression(context);
    console.log(`CYCLE_1_PASS accumulated=${getPassed()}`);
    console.log("CYCLE_2_START security, validation and data-integrity regression");
    await runSecurityCycle(context);
    console.log(`CYCLE_2_PASS accumulated=${getPassed()}`);
    console.log("CYCLE_3_START concurrency, race, degradation and UX regression");
    await runConcurrencyCycle(context);
    console.log(`CYCLE_3_PASS accumulated=${getPassed()}`);
    console.log(`COLLAB_THREE_CYCLE_PASS total=${getPassed()}`);
  } finally {
    if (context.admin) {
      await cleanupTestResources(context).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    }
  }
}

main().catch((error) => {
  console.error(`COLLAB_THREE_CYCLE_FAIL ${error.message}`);
  process.exitCode = 1;
});
