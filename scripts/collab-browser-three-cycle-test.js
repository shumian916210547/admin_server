"use strict";

/**
 * 使用真实 Chromium 页面执行在线协同表格三轮差异化回归，覆盖业务流程、响应式体验、异常恢复、
 * ONLYOFFICE 单元格编辑以及两个浏览器会话的筛选排序竞态。测试数据只使用当前 Company 的临时资源，
 * 脚本结束时通过公开 BFF 接口停用测试成员、删除测试岗位并软删除临时文档。
 */

const assert = require("assert/strict");
const crypto = require("crypto");
const dotenv = require("dotenv");
const path = require("path");

const { chromium } = require("playwright");

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const browserBaseUrl = process.env.BROWSER_TEST_BASE_URL || "http://localhost:4201";
const officeHost = process.env.OFFICE_DOCUMENT_SERVER_URL || "http://127.0.0.1:8080";
const browserWidth = 1440;
const browserHeight = 900;
const mobileWidth = 390;
const mobileHeight = 844;
const testSuffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const adminUsername = process.env.INITIAL_ADMIN_USERNAME;
const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;
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
const failures = [];
const resources = {
  documents: [],
  positions: [],
  members: [],
  editor: null,
};

/**
 * 记录一个测试断言，失败时继续执行同轮用例，以便一次回归收集完整缺陷清单。
 * @param {string} label 黑盒或白盒用例名称。
 * @param {boolean} condition 断言条件。
 * @param {string} [details] 失败时输出的安全诊断信息，不得包含凭据、Cookie 或令牌。
 * @returns {void} 更新通过计数或失败集合。
 */
function check(label, condition, details = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}`);
    return;
  }
  const message = details ? `${label}: ${details}` : label;
  failures.push(message);
  console.log(`FAIL ${message}`);
}

/**
 * 从 BFF 统一响应中提取 data 字段，兼容 204 空响应和直接业务对象。
 * @param {{body?: unknown}} response 已解析的浏览器请求响应。
 * @returns {any} 业务数据或原响应体。
 */
function dataOf(response) {
  return response?.body && Object.prototype.hasOwnProperty.call(response.body, "data")
    ? response.body.data
    : response?.body;
}

/**
 * 在当前浏览器页面内发起同源 BFF 请求，自动带上浏览器保存的 CSRF 令牌。
 * @param {import("playwright").Page} page 已认证的浏览器页面。
 * @param {string} requestPath 以 /api 开头的同源请求路径。
 * @param {{method?: string, body?: unknown, headers?: Record<string, string>}} [options] 请求方法和 JSON 请求体。
 * @returns {Promise<{status: number, headers: Record<string,string>, body: any, text: string}>} 响应状态、头和解析体。
 * @throws {Error} 页面关闭、脚本执行失败或网络请求无法完成时抛出。
 */
async function browserApi(page, requestPath, options = {}) {
  return page.evaluate(async ({ requestPath: targetPath, options: requestOptions }) => {
    const method = String(requestOptions.method || "GET").toUpperCase();
    const headers = { Accept: "application/json", ...(requestOptions.headers || {}) };
    const csrf = sessionStorage.getItem("shumian_admin_csrf");
    if (csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) headers["X-CSRF-Token"] = csrf;
    if (requestOptions.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(targetPath, {
      method,
      headers,
      credentials: "include",
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      text,
    };
  }, { requestPath, options });
}

/**
 * 登录一个全新的浏览器上下文并等待动态路由装配完成。
 * @param {import("playwright").BrowserContext} context 待建立会话的浏览器上下文。
 * @param {string} username 账号，只在当前请求中使用，不写入日志。
 * @param {string} password 密码，只在当前请求中使用，不写入日志。
 * @param {string} label 测试角色标签。
 * @returns {Promise<import("playwright").Page>} 已登录且位于首页的页面。
 * @throws {Error} 登录表单、会话建立或路由跳转失败时抛出。
 */
async function loginPage(context, username, password, label) {
  const page = await context.newPage();
  await page.goto(`${browserBaseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/home/, { timeout: 30_000 });
  check(`${label} 浏览器登录并进入首页`, /\/home/.test(page.url()));
  return page;
}

/**
 * 绑定 HTTP/控制台观测器，保留 5xx 和非预期控制台错误供最终报告使用。
 * @param {import("playwright").Page} page 待观测页面。
 * @returns {{httpErrors: Array<Record<string, unknown>>, consoleErrors: string[], optionalWarnings: string[], expectResponse: Function, expectConsoleError: Function}} 本页面的错误观测集合；测试显式触发的错误可登记为预期事件。
 */
function attachObservability(page) {
  const expectedResponses = [];
  const expectedConsoleErrors = [];
  const state = {
    httpErrors: [],
    consoleErrors: [],
    optionalWarnings: [],
    /**
     * 登记一个由当前测试步骤主动触发的预期响应，避免把异常恢复用例误报为服务故障。
     * @param {(response: import("playwright").Response) => boolean} predicate 响应匹配函数。
     * @returns {void} 将匹配函数加入一次性预期队列。
     */
    expectResponse: (predicate) => expectedResponses.push(predicate),
    /**
     * 登记一个由当前测试步骤主动触发的预期控制台错误。
     * @param {(text: string) => boolean} predicate 控制台文本匹配函数。
     * @returns {void} 将匹配函数加入一次性预期队列。
     */
    expectConsoleError: (predicate) => expectedConsoleErrors.push(predicate),
  };
  page.on("response", (response) => {
    const expectedIndex = expectedResponses.findIndex((predicate) => predicate(response));
    if (expectedIndex >= 0) {
      expectedResponses.splice(expectedIndex, 1);
      return;
    }
    if (response.status() >= 500) state.httpErrors.push({ status: response.status(), url: response.url() });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // 登录守卫在空会话首次恢复时产生的 401 是预期分支，不作为页面运行错误。
    if (text.includes("401 (Unauthorized)") && text.includes("Failed to load resource")) return;
    const expectedIndex = expectedConsoleErrors.findIndex((predicate) => predicate(text));
    if (expectedIndex >= 0) {
      expectedConsoleErrors.splice(expectedIndex, 1);
      return;
    }
    const sourceUrl = message.location()?.url || "";
    // 首页天气的位置服务是可选的第三方能力；其 429 只会触发页面已有的天气降级提示，
    // 不应把外部供应商限流误报为协同表格页面运行错误，但仍保留诊断记录供报告说明。
    if (sourceUrl === "https://ipapi.co/json/" && /status of 429/i.test(text)) {
      state.optionalWarnings.push(`${text} [${sourceUrl}]`);
      return;
    }
    state.consoleErrors.push(sourceUrl ? `${text} [${sourceUrl}]` : text);
  });
  return state;
}

/**
 * 打开协同表格页面并等待列表加载完成。
 * @param {import("playwright").Page} page 已登录页面。
 * @returns {Promise<void>} 协同表格页面列表和筛选区可用后兑现。
 */
async function gotoCollab(page) {
  await page.goto(`${browserBaseUrl}/collab/spreadsheet`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator(".collab-page__filters").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".collab-page__table .el-table__body-wrapper").waitFor({ state: "visible", timeout: 30_000 });
}

/**
 * 读取当前登录成员可见的全部协同文档，用于等待 UI 刷新和确认测试资源精确标识。
 * @param {import("playwright").Page} page 已登录页面。
 * @param {string} [status="active"] 文档状态筛选。
 * @returns {Promise<Array<Record<string, unknown>>>} BFF 返回的安全文档 DTO 数组。
 */
async function listDocuments(page, status = "active") {
  const response = await browserApi(page, `/api/collab/documents?page=1&pageSize=100&status=${encodeURIComponent(status)}`);
  return Array.isArray(dataOf(response)?.documents) ? dataOf(response).documents : [];
}

/**
 * 等待指定名称的文档出现在当前列表，并返回安全 DTO。
 * @param {import("playwright").Page} page 已登录页面。
 * @param {string} name 文档名称。
 * @param {string} [status="active"] 文档状态。
 * @returns {Promise<Record<string, unknown>>} 找到的文档 DTO。
 * @throws {Error} 超时仍未找到文档时抛出。
 */
async function waitDocument(page, name, status = "active") {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const document = (await listDocuments(page, status)).find((item) => item.name === name);
    if (document) return document;
    await page.waitForTimeout(500);
  }
  throw new Error(`未找到测试文档：${name}`);
}

/**
 * 通过页面上的新建工作簿对话框创建文档，验证表单和成功刷新路径。
 * @param {import("playwright").Page} page 已登录且位于协同页面的管理员页面。
 * @param {string} name 工作簿名称。
 * @param {boolean} [companyPublic=false] 是否走企业内公开二次确认。
 * @returns {Promise<Record<string, unknown>>} 创建后的文档 DTO。
 * @throws {Error} 对话框、确认框或 BFF 创建失败时抛出。
 */
async function createDocumentViaUi(page, name, companyPublic = false) {
  await page.getByRole("button", { name: "新建工作簿" }).click();
  const dialog = page.locator(".el-dialog:visible").filter({ hasText: "新建工作簿" }).last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.locator("input").first().fill(name);
  if (companyPublic) {
    // Element Plus radio 的原生 input 被视觉隐藏，点击可见 label 容器才能模拟真实用户操作。
    await dialog.locator(".el-radio").filter({ hasText: "企业内公开查看" }).click();
  }
  await dialog.getByRole("button", { name: "创建工作簿" }).click();
  if (companyPublic) {
    const messageBox = page.locator(".el-message-box:visible");
    await messageBox.waitFor({ state: "visible", timeout: 10_000 });
    check("企业内公开创建显示中文二次确认", (await messageBox.innerText()).includes("企业内公开"));
    await messageBox.getByRole("button", { name: "确认创建" }).click();
  }
  const document = await waitDocument(page, name);
  resources.documents.push(document.id);
  check(`浏览器创建工作簿：${companyPublic ? "企业内公开" : "指定成员"}`, document.name === name);
  // 创建接口返回后页面路由由 Vue 异步切换；先确认编辑页已完成导航，再读取隔离页面断言，
  // 避免在公开创建的二次确认关闭瞬间把列表页误判为创建失败。
  await page.waitForURL(/\/collab\/spreadsheet\/editor\?documentId=/, { timeout: 30_000 });
  check(`浏览器创建后进入独立编辑页：${name}`, /\/collab\/spreadsheet\/editor\?documentId=/.test(page.url()));
  check(`独立编辑页不渲染文档列表：${name}`, await page.locator(".collab-page__table").count() === 0);
  await gotoCollab(page);
  return document;
}

/**
 * 返回指定文档在协同列表中的真实表格行，避免依赖行号和后端排序顺序。
 * @param {import("playwright").Page} page 协同表格页面。
 * @param {string} name 文档名称。
 * @returns {import("playwright").Locator} 当前文档表格行定位器。
 */
function documentRow(page, name) {
  return page.locator(".collab-page__table .el-table__body-wrapper tbody tr").filter({ hasText: name }).first();
}

/**
 * 在页面的多个 ONLYOFFICE iframe 候选中选择当前可交互的编辑器实例。
 * @param {import("playwright").Page} page 承载一个或多个编辑器 iframe 的业务页面。
 * @returns {Promise<import("playwright").Frame | null>} 包含可见画布或公式栏的编辑器实例；未就绪时返回 null。
 */
async function findOfficeFrame(page) {
  const candidates = page.frames().filter((frame) => frame.url().includes("spreadsheeteditor")).reverse();
  let contentFrame = null;
  for (const frame of candidates) {
    const hasCanvas = await frame.locator("#ws-canvas-graphic-overlay:visible").count().catch(() => 0);
    const hasCellContent = await frame.locator("#ce-cell-content:visible").count().catch(() => 0);
    if (hasCanvas > 0) return frame;
    if (hasCellContent > 0 && !contentFrame) contentFrame = frame;
  }
  return contentFrame;
}

/**
 * 打开文档并等待 ONLYOFFICE 真正触发 ready 事件，验证页面显示连接成功而非仅 iframe 创建成功。
 * @param {import("playwright").Page} page 已登录的协同页面。
 * @param {string} name 文档名称。
 * @returns {Promise<import("playwright").Frame>} ONLYOFFICE spreadsheeteditor iframe。
 * @throws {Error} 文档行、iframe 或连接状态超时。
 */
async function openOfficeDocument(page, name) {
  const row = documentRow(page, name);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await Promise.all([
    page.waitForURL(/\/collab\/spreadsheet\/editor\?documentId=/, { timeout: 30_000 }),
    row.getByRole("button", { name: "打开" }).click(),
  ]);
  check(`列表打开后进入独立编辑页：${name}`, /\/collab\/spreadsheet\/editor\?documentId=/.test(page.url()));
  check(`独立编辑页与列表页面隔离：${name}`, await page.locator(".collab-page__table").count() === 0);
  await page.locator(".spreadsheet-shell").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(".spreadsheet-shell iframe").waitFor({ state: "attached", timeout: 90_000 });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const text = await page.locator(".spreadsheet-shell").innerText();
    const frame = await findOfficeFrame(page);
    if (frame && text.includes("已连接")) {
      check(`ONLYOFFICE 连接成功：${name}`, frame.url().startsWith(officeHost));
      check(`编辑器引擎显示 ONLYOFFICE：${name}`, text.includes("引擎：ONLYOFFICE"));
      const officeText = await frame.locator("body").innerText().catch(() => "");
      check(`ONLYOFFICE 界面显示中文菜单：${name}`, /文件|主页|插入|数据/.test(officeText));
      check(`编辑器提示协同选区姓名：${name}`, text.includes("悬停在其他成员的彩色选中单元格上即可查看成员姓名"));
      return frame;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`ONLYOFFICE 连接超时：${name}`);
}

/**
 * 通过浏览器实际请求校验当前工作簿的协同显示契约，确保页面没有只渲染颜色而遗漏成员身份配置。
 * @param {import("playwright").Page} page 已认证并打开协同页面的浏览器页面。
 * @param {string} documentId 当前工作簿 UUID。
 * @param {string} label 当前会话标签，用于输出可读测试结果。
 * @returns {Promise<void>} 中文地区、Fast 协同模式和非空用户姓名断言完成后兑现。
 * @throws {Error} 浏览器请求执行失败时抛出。
 */
async function assertOfficeCollaborationConfig(page, documentId, label) {
  const response = await browserApi(page, `/api/collab/documents/${documentId}/editor-config`);
  const editorConfig = dataOf(response)?.editor?.config?.editorConfig;
  check(`${label} 编辑器配置使用简体中文`, response.status === 200 && editorConfig?.lang === "zh" && editorConfig?.region === "zh-CN");
  check(`${label} 编辑器使用固定 Fast 协同模式`, editorConfig?.coEditing?.mode === "fast" && editorConfig?.coEditing?.change === false);
  check(`${label} 编辑器配置包含成员姓名`, typeof editorConfig?.user?.name === "string" && editorConfig.user.name.trim().length > 0);
}

/**
 * 在 ONLYOFFICE 画布中选择稳定的 A2 单元格并输入值；选择结果由名称框确认，避免误把工具栏作为编辑目标。
 * @param {import("playwright").Page} page 承载编辑器的页面。
 * @param {import("playwright").Frame} frame ONLYOFFICE iframe。
 * @param {string} value 待写入的测试文本。
 * @returns {Promise<string>} 编辑器名称框最终选中的单元格名称。
 * @throws {Error} 画布或名称框不可用时抛出。
 */
async function editOfficeCell(page, frame, value) {
  const canvas = frame.locator("#ws-canvas-graphic-overlay");
  await canvas.waitFor({ state: "visible", timeout: 30_000 });
  const cellNameInput = frame.locator("#ce-cell-name:visible").last();
  let cellName = "";
  for (const y of [25, 42, 64]) {
    await canvas.click({ position: { x: 85, y } });
    cellName = await cellNameInput.inputValue();
    if (cellName === "A2") break;
  }
  const targetCellName = cellName;
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_000);
  check("ONLYOFFICE 选中可编辑单元格 A2", targetCellName === "A2", `实际选择 ${targetCellName}`);
  return targetCellName;
}

/**
 * 在 ONLYOFFICE 画布上悬停远程协同选区，确认页面实际显示远程成员姓名而不是只有颜色边框。
 * @param {import("playwright").Page} page 承载编辑器的业务页面。
 * @param {import("playwright").Frame} frame 当前 ONLYOFFICE spreadsheeteditor iframe。
 * @param {string} expectedName 另一浏览器会话在 editorConfig.user.name 中使用的成员姓名。
 * @param {string} label 当前浏览器方向的安全诊断标签。
 * @returns {Promise<void>} 在限定时间内观察到成员姓名后兑现；未观察到时记录失败但不阻断同轮后续清理。
 */
async function assertRemoteSelectionName(page, frame, expectedName, label) {
  const canvas = frame.locator("#ws-canvas-graphic-overlay:visible");
  const hoverPositions = [
    { x: 85, y: 42 },
    { x: 85, y: 64 },
    { x: 110, y: 42 },
  ];
  const deadline = Date.now() + 12_000;
  let observedText = "";
  while (Date.now() < deadline) {
    for (const position of hoverPositions) {
      await canvas.hover({ position }).catch(() => undefined);
      await page.waitForTimeout(250);
      observedText = await frame.locator("body").innerText().catch(() => "");
      if (expectedName && observedText.includes(expectedName)) {
        check(`${label} 悬停远程选区显示成员姓名`, true);
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  check(`${label} 悬停远程选区显示成员姓名`, false, `未观察到“${expectedName}”；编辑器文本=${observedText.replace(/\s+/g, " ").slice(-320)}`);
}

/**
 * 等待 ONLYOFFICE 选中单元格的内容完成异步刷新，并返回最后一次观测值。
 * @param {import("playwright").Page} page 承载编辑器的业务页面，用于等待下一次轮询。
 * @param {import("playwright").Frame} frame ONLYOFFICE spreadsheeteditor iframe。
 * @param {string[]} expectedValues 允许出现的完整测试值集合。
 * @param {number} [timeoutMs=15000] 最长等待时长，单位为毫秒。
 * @returns {Promise<string>} 匹配到的单元格内容；超时则返回最后一次读取到的内容，由调用方记录失败。
 */
async function waitForOfficeCellValue(page, frame, expectedValues, timeoutMs = 15_000) {
  const contentInput = frame.locator("#ce-cell-content:visible").last();
  const deadline = Date.now() + timeoutMs;
  let currentValue = "";
  while (Date.now() < deadline) {
    currentValue = await contentInput.inputValue().catch(() => "");
    if (expectedValues.some((expectedValue) => expectedValue && currentValue.includes(expectedValue))) return currentValue;
    await page.waitForTimeout(250);
  }
  return currentValue;
}

/**
 * 离开当前编辑器，触发 ONLYOFFICE status=2 保存回调，并等待 BFF 修订号增长。
 * @param {import("playwright").Page} page 编辑器所在页面。
 * @param {string} documentId 文档 UUID。
 * @param {number} previousRevision 离开前修订号。
 * @returns {Promise<Record<string, unknown>>} 保存后的文档 DTO。
 * @throws {Error} 30 秒内未观察到修订递增时抛出。
 */
async function leaveOfficeAndWaitRevision(page, documentId, previousRevision) {
  await page.waitForTimeout(2_000);
  await page.goto(`${browserBaseUrl}/home`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await browserApi(page, `/api/collab/documents/${documentId}`);
    const document = dataOf(response);
    if (response.status === 200 && Number(document?.currentRevision) > previousRevision) return document;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`ONLYOFFICE 保存回调未使修订号递增：${documentId}`);
}

/**
 * 检查指定表格操作列的按钮可见性、文本完整性和单元格溢出样式。
 * @param {import("playwright").Page} page 当前业务页面。
 * @param {string} tableSelector 页面表格 CSS 选择器。
 * @param {string} label 用例名称。
 * @param {boolean} [scrollRight=false] 是否先把表格内部滚动到最右侧。
 * @returns {Promise<number>} 检查到的按钮数量。
 */
async function assertOperationColumn(page, tableSelector, label, scrollRight = false) {
  const table = page.locator(tableSelector).first();
  await table.waitFor({ state: "visible", timeout: 15_000 });
  await table.locator(".el-table__body-wrapper tbody tr").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (scrollRight) {
    await table.locator(".el-table__body-wrapper").evaluateAll((wrappers) => wrappers.forEach((wrapper) => { wrapper.scrollLeft = wrapper.scrollWidth; }));
    await page.waitForTimeout(100);
  }
  const cells = table.locator(".el-table__body-wrapper .table-operation-column:visible");
  const cellCount = await cells.count();
  let buttonCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const cell = cells.nth(index);
    const cellBox = await cell.boundingBox();
    const cellStyle = await cell.locator(".cell").first().evaluate((element) => ({
      overflow: getComputedStyle(element).overflow,
      whiteSpace: getComputedStyle(element).whiteSpace,
    })).catch(() => null);
    const buttons = cell.locator("button:visible");
    const count = await buttons.count();
    buttonCount += count;
    for (let buttonIndex = 0; buttonIndex < count; buttonIndex += 1) {
      const button = buttons.nth(buttonIndex);
      const text = (await button.innerText()).trim();
      const buttonBox = await button.boundingBox();
      check(`${label} 操作按钮文本完整`, Boolean(text));
      if (cellBox && buttonBox) {
        check(`${label} 操作按钮未被单元格裁剪`, buttonBox.x >= cellBox.x - 2 && buttonBox.x + buttonBox.width <= cellBox.x + cellBox.width + 2, `${text} 超出操作单元格`);
      }
    }
    if (cellStyle) check(`${label} 操作单元格解除 overflow 裁剪`, cellStyle.overflow !== "hidden");
  }
  check(`${label} 至少渲染一个操作按钮`, buttonCount > 0);
  return buttonCount;
}

/**
 * 检查 Element Plus 分页器是否完全使用中文文案，并验证页容量下拉框可打开。
 * @param {import("playwright").Page} page 当前业务页面。
 * @param {string} label 页面名称。
 * @returns {Promise<void>} 分页文案和交互检查完成后兑现。
 */
async function assertChinesePagination(page, label) {
  const pager = page.locator(".el-pagination:visible").first();
  if (!(await pager.count())) {
    check(`${label} 分页按数据量正确隐藏`, true);
    return;
  }
  const text = await pager.innerText();
  check(`${label} 分页总数为中文`, /共\s*\d+\s*条/.test(text), text.slice(0, 160));
  check(`${label} 分页容量为中文`, /\d+\s*条\/页/.test(text), text.slice(0, 160));
  check(`${label} 分页无英文默认文案`, !/Total|items per page|Previous|Next|Go to/i.test(text), text.slice(0, 160));
  const sizeSelect = pager.locator(".el-pagination__sizes .el-select");
  if (await sizeSelect.count()) {
    await sizeSelect.locator(".el-select__wrapper").click();
    const options = page.locator(".el-select-dropdown__item:visible");
    await options.first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    const optionText = await options.allTextContents();
    check(`${label} 页容量下拉选项为中文`, optionText.length > 0 && optionText.every((item) => /条\/页/.test(item)), optionText.join("|"));
    await page.keyboard.press("Escape");
  }
}

/**
 * 检查页面不产生整页横向溢出，并把所有 Element Plus 表格内部滚动到右端验证操作列可达。
 * @param {import("playwright").Page} page 当前页面。
 * @param {string} label 页面名称。
 * @returns {Promise<void>} 窄屏布局和表格滚动检查完成后兑现。
 */
async function assertMobileTables(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(`${label} 窄屏页面无整页横向溢出`, overflow, `scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}`);
  const wrappers = page.locator(".el-table:visible .el-table__body-wrapper");
  const wrapperCount = await wrappers.count();
  for (let index = 0; index < wrapperCount; index += 1) {
    await wrappers.nth(index).evaluate((wrapper) => { wrapper.scrollLeft = wrapper.scrollWidth; });
  }
  await page.waitForTimeout(100);
}

/**
 * 读取管理员岗位和组织目录，创建一个仅拥有协同表格页面权限的临时编辑岗位与成员。
 * @param {import("playwright").Page} page 管理员页面。
 * @returns {Promise<{username: string, password: string, id: string}>} 编辑成员登录凭据和用户标识，仅保存在内存中。
 * @throws {Error} 岗位、组织或成员 BFF 创建失败时抛出。
 */
async function createEditorFixture(page) {
  const positionOverview = dataOf(await browserApi(page, "/api/positions/overview"));
  const collabRoute = positionOverview?.routes?.find((route) => route.path === "spreadsheet");
  assert.ok(collabRoute?.objectId, "协同表格 Route 目录存在");
  const organizationOverview = dataOf(await browserApi(page, "/api/organization/overview"));
  const organizations = organizationOverview?.organizations || organizationOverview?.nodes || [];
  const organization = organizations.find((item) => item.isActive !== false && item.objectId);
  assert.ok(organization?.objectId, "至少存在一个可用组织");
  const positionName = `浏览器三轮编辑岗位-${testSuffix}`;
  const positionResponse = await browserApi(page, "/api/positions", {
    method: "POST",
    body: {
      name: positionName,
      pagePermissions: [{ routeId: collabRoute.objectId, permissions: spreadsheetPermissions }],
    },
  });
  check("创建浏览器并发测试岗位", positionResponse.status === 201);
  const position = dataOf(positionResponse);
  resources.positions.push(position.objectId);
  const username = `browserqa_${testSuffix}`;
  const password = `BrowserQA-${testSuffix}-Password!`;
  const memberResponse = await browserApi(page, "/api/organization/members", {
    method: "POST",
    body: {
      username,
      password,
      name: `浏览器并发编辑-${testSuffix}`,
      nickname: "浏览器回归编辑者",
      email: `${username}@invalid.test`,
      roleId: position.objectId,
      organizationIds: [organization.objectId],
      scopeIds: [organization.objectId],
      organizationAdmin: false,
    },
  });
  check("创建浏览器并发测试成员", memberResponse.status === 201);
  const member = dataOf(memberResponse);
  resources.members.push(member.objectId);
  resources.editor = { id: member.objectId, username, password, name: member.name };
  return resources.editor;
}

/**
 * 在分享抽屉中为指定成员设置编辑角色并开启文档下载总开关，验证成员 ACL 表单交互。
 * @param {import("playwright").Page} page 管理员协同页面。
 * @param {string} documentName 目标文档名称。
 * @param {{username: string, name?: string}} editor 编辑成员安全标识。
 * @returns {Promise<void>} 分享设置保存后抽屉关闭。
 * @throws {Error} 成员下拉框、角色选择或保存请求失败时抛出。
 */
async function shareDocumentWithEditor(page, documentName, editor) {
  const row = documentRow(page, documentName);
  await row.getByRole("button", { name: "分享" }).click();
  const drawer = page.locator(".collab-share-dialog:visible");
  await drawer.waitFor({ state: "visible", timeout: 15_000 });
  check(`分享抽屉显示：${documentName}`, (await drawer.innerText()).includes("分享与权限"));
  // Element Plus 的原生 checkbox input 为无障碍/表单代理元素且默认不可见，
  // 交互必须定位可见的 .el-checkbox 外层，状态读取仍通过 input 完成。
  const downloadCheckbox = drawer.locator(".el-checkbox").filter({ hasText: "允许符合条件的成员下载或导出" }).first();
  const downloadCheckboxInput = downloadCheckbox.locator("input[type=checkbox]");
  const readyDeadline = Date.now() + 15_000;
  while (await downloadCheckboxInput.isDisabled() && Date.now() < readyDeadline) await page.waitForTimeout(250);
  if (await downloadCheckboxInput.isDisabled()) throw new Error(`分享配置加载未完成：${documentName}`);
  if (await downloadCheckbox.count() && !(await downloadCheckboxInput.isChecked())) await downloadCheckbox.click();
  const memberSelect = drawer.locator(".collab-share-dialog__member-select");
  const memberOptionsResponse = await browserApi(page, `/api/collab/documents/${encodeURIComponent((await listDocuments(page)).find((item) => item.name === documentName)?.id || "")}/member-options`);
  const memberOptions = Array.isArray(dataOf(memberOptionsResponse)) ? dataOf(memberOptionsResponse) : [];
  check(`分享成员接口返回目标成员：${documentName}`, memberOptions.some((item) => item.username === editor.username));
  await memberSelect.locator(".el-select__wrapper").click();
  // 成员数量较多时列表会进入滚动区域；先用 filterable 输入框按账号检索，
  // 既覆盖真实用户的检索体验，也避免把滚动区域之外的选项误判为不可见。
  await memberSelect.locator("input.el-select__input").fill(editor.username);
  // 下拉弹层由 Element Plus teleport 到 body；弹层根节点在动画期间可能仍带有
  // 非 visible 状态，因此直接以可见 option 作为交互目标更稳定。
  const options = page.locator('.el-select__popper[aria-hidden="false"] .el-select-dropdown__item');
  const targetOption = options.filter({ hasText: editor.username }).first();
  console.log(`SHARE_OPTIONS ${documentName} count=${await options.count()} target=${await targetOption.count() > 0}`);
  await targetOption.waitFor({ state: "attached", timeout: 15_000 });
  // 下拉选项在 Element Plus 的 teleport/过渡结束瞬间可能重新计算布局；等待一帧后再点击
  // 当前打开的 popper，避免把隐藏的其他选择器选项误判为目标。
  await page.waitForTimeout(300);
  await targetOption.click({ force: true });
  const roleWrapper = drawer.locator(".collab-share-dialog__role-select .el-select__wrapper");
  await roleWrapper.click();
  // 角色下拉层由 Element Plus teleport 到 drawer 外部，在部分窗口布局中选项坐标会短暂落在视口外；
  // 使用组件原生键盘导航仍是用户可用的无障碍交互，并且不会误点成员选择器的同名文本。
  const roleInput = roleWrapper.locator("input[role=combobox]");
  await roleInput.press("End");
  await roleInput.press("Enter");
  await drawer.getByRole("button", { name: "添加" }).click();
  const addedMemberRow = drawer.locator(".collab-share-dialog__table .el-table__body-wrapper tbody tr").filter({ hasText: editor.username }).first();
  const addedMemberRowText = await addedMemberRow.innerText().catch(() => "");
  const addedMemberRoleText = await addedMemberRow.locator(".el-select__wrapper").first().innerText().catch(() => "");
  check(
    `分享抽屉追加编辑成员：${documentName}`,
    addedMemberRowText.includes(editor.username) && addedMemberRoleText === "编辑",
    `${addedMemberRoleText || "未读取角色"}；${addedMemberRowText || "未找到新增成员行"}`,
  );
  const memberSaveRequestPromise = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().includes(`/api/collab/documents/`),
    { timeout: 15_000 },
  );
  await drawer.getByRole("button", { name: "保存分享设置" }).click();
  const memberSaveRequest = await memberSaveRequestPromise;
  console.log(`SHARE_SAVE_PAYLOAD ${documentName} ${memberSaveRequest.postData() || ""}`);
  await drawer.waitFor({ state: "hidden", timeout: 15_000 });
  const document = (await listDocuments(page)).find((item) => item.name === documentName);
  check(`分享设置保存后文档仍可见：${documentName}`, Boolean(document));
  const persistedMembersResponse = document
    ? await browserApi(page, `/api/collab/documents/${encodeURIComponent(document.id)}/members`)
    : null;
  const persistedMember = dataOf(persistedMembersResponse)?.members?.find((member) => member.userId === editor.id);
  check(
    `分享设置保存后服务端 ACL 为编辑：${documentName}`,
    persistedMember?.role === "editor",
    persistedMember ? `服务端角色=${persistedMember.role}` : "服务端未找到目标成员",
  );
}

/**
 * 通过真实分享抽屉转移工作簿所有权，并用新所有者重新打开独立编辑页确认页面元数据。
 * @param {import("playwright").Page} ownerPage 当前所有者或管理员的协同页面。
 * @param {import("playwright").Page} newOwnerPage 转移后新所有者的已认证浏览器页面。
 * @param {string} documentName 待转移工作簿名称。
 * @param {{id: string, username: string, name?: string}} newOwner 转移目标成员安全标识。
 * @returns {Promise<Record<string, unknown>>} 转移后的文档安全 DTO。
 * @throws {Error} 分享抽屉、成员选项、中文确认框或所有权更新请求无法完成时抛出。
 */
async function transferDocumentOwnershipViaUi(ownerPage, newOwnerPage, documentName, newOwner) {
  const document = (await listDocuments(ownerPage)).find((item) => item.name === documentName);
  if (!document?.id) throw new Error(`所有权转移测试未找到文档：${documentName}`);
  const row = documentRow(ownerPage, documentName);
  await row.getByRole("button", { name: "分享" }).click();
  const drawer = ownerPage.locator(".collab-share-dialog:visible");
  await drawer.waitFor({ state: "visible", timeout: 15_000 });
  const ownerSelect = drawer.locator(".collab-share-dialog__owner-select");
  await ownerSelect.locator(".el-select__wrapper").click();
  await ownerSelect.locator("input.el-select__input").fill(newOwner.username);
  const options = ownerPage.locator('.el-select__popper[aria-hidden="false"] .el-select-dropdown__item');
  const targetOption = options.filter({ hasText: newOwner.username }).first();
  await targetOption.waitFor({ state: "attached", timeout: 15_000 });
  await ownerPage.waitForTimeout(300);
  await targetOption.click({ force: true });
  const selectedText = await ownerSelect.locator(".el-select__wrapper").innerText();
  check("分享抽屉选择新的文件所有者", selectedText.includes(newOwner.username));

  const transferResponsePromise = ownerPage.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(`/api/collab/documents/${document.id}/transfer-ownership`),
    { timeout: 20_000 },
  );
  await drawer.getByRole("button", { name: "转移所有权" }).click();
  const confirmBox = ownerPage.locator(".el-message-box:visible");
  await confirmBox.waitFor({ state: "visible", timeout: 10_000 });
  const confirmText = await confirmBox.innerText();
  check("所有权转移显示中文二次确认", confirmText.includes("确认转移文件所有权") && confirmText.includes("转移后当前所有者"));
  await confirmBox.getByRole("button", { name: "确认转移" }).click();
  const transferResponse = await transferResponsePromise;
  check("浏览器所有权转移请求成功", transferResponse.status() === 200, `HTTP ${transferResponse.status()}`);
  await drawer.waitFor({ state: "hidden", timeout: 15_000 });

  const updatedResponse = await browserApi(ownerPage, `/api/collab/documents/${document.id}`);
  const updated = dataOf(updatedResponse);
  check("所有权转移后文档详情显示新 owner", updatedResponse.status === 200 && updated.ownerUserId === newOwner.id);
  check("所有权转移后创建者名称保持不变", updated.createdByName === document.createdByName);
  check("所有权转移后 owner 名称来自服务端成员资料", updated.ownerName === (newOwner.name || newOwner.username));
  const membersResponse = await browserApi(ownerPage, `/api/collab/documents/${document.id}/members`);
  const members = dataOf(membersResponse)?.members || [];
  check("所有权转移后原 owner 保留 editor 权限", members.some((member) => member.userId === document.ownerUserId && member.role === "editor" && member.status === "active"));
  check("所有权转移后新 owner 为 active owner", members.some((member) => member.userId === newOwner.id && member.role === "owner" && member.status === "active"));

  await newOwnerPage.goto(`${browserBaseUrl}/collab/spreadsheet/editor?documentId=${encodeURIComponent(document.id)}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await newOwnerPage.locator(".collab-editor-page").waitFor({ state: "visible", timeout: 30_000 });
  const ownerMeta = newOwnerPage.locator(".collab-editor-page__meta").filter({ hasText: `当前所有者：${updated.ownerName}` });
  await ownerMeta.waitFor({ state: "visible", timeout: 30_000 });
  const editorText = await newOwnerPage.locator(".collab-editor-page").innerText();
  check(
    "新 owner 独立编辑页显示当前所有者",
    editorText.includes(`当前所有者：${updated.ownerName}`),
    `url=${newOwnerPage.url()} owner=${updated.ownerName} text=${editorText.slice(0, 260)}`,
  );
  await newOwnerPage.goto(`${browserBaseUrl}/home`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return updated;
}

/**
 * 通过真实 file input 导入 CSV，验证成功路径会创建新工作簿并自动打开。
 * @param {import("playwright").Page} page 管理员协同页面。
 * @param {string} name 导入文件名，去掉扩展名后即为文档名称。
 * @returns {Promise<Record<string, unknown>>} 导入生成的文档 DTO。
 * @throws {Error} 文件选择、上传或列表刷新失败时抛出。
 */
async function importCsvViaUi(page, name) {
  const input = page.locator("input[type=file][accept*='.csv']").first();
  await input.setInputFiles({
    name: `${name}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from("name,value\nalpha,1\nbeta,2\n", "utf8"),
  });
  const document = await waitDocument(page, name);
  resources.documents.push(document.id);
  check("浏览器导入 CSV 并生成新工作簿", document.name === name);
  await page.waitForURL(/\/collab\/spreadsheet\/editor\?documentId=/, { timeout: 30_000 });
  check("浏览器导入后进入独立编辑页", /\/collab\/spreadsheet\/editor\?documentId=/.test(page.url()));
  check("导入后的独立编辑页不渲染文档列表", await page.locator(".collab-page__table").count() === 0);
  await gotoCollab(page);
  return document;
}

/**
 * 执行第 1 轮业务主流程：创建、真实编辑保存、命名版本、分享、导出、重命名和导入。
 * @param {import("playwright").Page} page 管理员页面。
 * @returns {Promise<{document: Record<string, unknown>, imported: Record<string, unknown>}>} 后续轮次复用的文档。
 * @throws {Error} 关键主流程失败时抛出并由总控记录。
 */
async function runBusinessCycle(page) {
  console.log("CYCLE_1_START browser business workflow and ONLYOFFICE save");
  await gotoCollab(page);
  await assertOperationColumn(page, ".collab-page__table", "第1轮协同表格桌面操作列");
  await assertChinesePagination(page, "第1轮协同表格");
  const documentName = `浏览器三轮业务-${testSuffix}`;
  const document = await createDocumentViaUi(page, documentName);
  const beforeRevision = Number(document.currentRevision);
  const frame = await openOfficeDocument(page, documentName);
  await assertOfficeCollaborationConfig(page, document.id, "第1轮管理员");
  await editOfficeCell(page, frame, `BROWSER_CYCLE_1_${testSuffix}`);
  const saved = await leaveOfficeAndWaitRevision(page, document.id, beforeRevision);
  check("ONLYOFFICE 浏览器编辑保存回调使修订号递增", saved.currentRevision > beforeRevision);
  await gotoCollab(page);
  await shareDocumentWithEditor(page, documentName, resources.editor);
  const row = documentRow(page, documentName);
  await row.getByRole("button", { name: "版本" }).click();
  const versionPanel = page.locator(".collab-version-panel:visible");
  await versionPanel.waitFor({ state: "visible", timeout: 15_000 });
  await versionPanel.getByRole("button", { name: "命名版本" }).click();
  const versionDialog = page.locator(".el-dialog:visible").filter({ hasText: "创建命名版本" }).last();
  await versionDialog.getByLabel("版本名称").fill(`浏览器命名版本-${testSuffix}`);
  // Element Plus 弹窗在输入校验和过渡结束时可能重绘按钮；强制点击当前可见实例，
  // 仍然通过按钮的中文可访问名称定位，避免将动画重绘误报为业务失败。
  await versionDialog.getByRole("button", { name: "保存版本" }).click({ force: true });
  await versionDialog.waitFor({ state: "hidden", timeout: 15_000 });
  check("浏览器创建命名版本", (await versionPanel.innerText()).includes(`浏览器命名版本-${testSuffix}`));
  await versionPanel.getByRole("button", { name: "关闭", exact: true }).click();
  await row.getByRole("button", { name: "导出" }).waitFor({ state: "visible", timeout: 15_000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await row.getByRole("button", { name: "导出" }).click();
  const download = await downloadPromise;
  check("浏览器导出工作簿触发下载", /\.xlsx$/i.test(download.suggestedFilename()));
  await row.getByRole("button", { name: "重命名" }).click();
  const renameDialog = page.locator(".el-dialog:visible").filter({ hasText: "修改文档名称" }).last();
  const renamed = `浏览器三轮业务重命名-${testSuffix}`;
  await renameDialog.getByLabel("文档名称").fill(renamed);
  await renameDialog.getByRole("button", { name: "保存名称" }).click();
  await waitDocument(page, renamed);
  check("浏览器重命名工作簿", (await documentRow(page, renamed).innerText()).includes(renamed));
  const importedName = `浏览器三轮导入-${testSuffix}`;
  const imported = await importCsvViaUi(page, importedName);
  await shareDocumentWithEditor(page, importedName, resources.editor);
  console.log(`CYCLE_1_PASS business document=${document.id} imported=${imported.id}`);
  return { document: { ...document, name: renamed }, imported };
}

/**
 * 触发一次文档删除确认并点击取消，确认取消期间没有改变列表状态。
 * @param {import("playwright").Page} page 管理员协同页面。
 * @param {string} name 目标文档名称。
 * @returns {Promise<void>} 取消确认后文档仍在正常列表。
 */
async function cancelDelete(page, name) {
  const row = documentRow(page, name);
  await row.getByRole("button", { name: "删除" }).click();
  const messageBox = page.locator(".el-message-box:visible");
  await messageBox.waitFor({ state: "visible", timeout: 10_000 });
  check("删除操作显示中文二次确认", (await messageBox.innerText()).includes("删除"));
  await messageBox.getByRole("button", { name: "取消" }).click();
  check("取消删除后文档仍在正常列表", Boolean(await documentRow(page, name).count()));
}

/**
 * 通过真实文件选择器提交伪造 xlsx，验证导入错误提示和临时文档补偿清理。
 * @param {import("playwright").Page} page 管理员协同页面。
 * @param {{expectResponse: Function, expectConsoleError: Function}} [observation] 当前页面错误观测器，用于登记测试主动触发的错误响应。
 * @returns {Promise<void>} 失败通知出现且临时文档未遗留后兑现。
 */
async function testInvalidImport(page, observation) {
  const before = (await listDocuments(page)).length;
  const input = page.locator("input[type=file][accept*='.xlsx']").first();
  observation?.expectResponse((response) => response.status() === 400 && response.request().method() === "POST" && response.url().includes("/api/collab/documents/"));
  observation?.expectConsoleError((text) => text.includes("status of 400") || text.includes("400 (Bad Request)"));
  await input.setInputFiles({ name: `浏览器伪造文件-${testSuffix}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("not-xlsx") });
  const notification = page.locator(".el-notification:visible").filter({ hasText: "导入失败" }).last();
  await notification.waitFor({ state: "visible", timeout: 20_000 });
  check("非法 xlsx 导入显示可操作中文错误", /xlsx|文件|格式/.test(await notification.innerText()));
  await page.waitForTimeout(1_000);
  check("非法导入失败后临时工作簿已清理", (await listDocuments(page)).length === before);
}

/**
 * 在窄屏页面打开分享和版本抽屉，验证宽度自适应、内容无横向溢出且关闭路径可用。
 * @param {import("playwright").Page} page 管理员窄屏页面。
 * @param {string} name 目标文档名称。
 * @returns {Promise<void>} 抽屉布局检查完成后兑现。
 */
async function testNarrowDrawers(page, name) {
  const row = documentRow(page, name);
  await row.getByRole("button", { name: "分享" }).click();
  const shareDrawer = page.locator(".collab-share-dialog:visible");
  await shareDrawer.waitFor({ state: "visible", timeout: 15_000 });
  const shareWidth = await shareDrawer.boundingBox();
  const shareOverflow = await shareDrawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  check("390px 分享抽屉宽度自适应", Boolean(shareWidth && shareWidth.width <= mobileWidth + 1), JSON.stringify(shareWidth));
  check("390px 分享抽屉无横向溢出", shareOverflow);
  await shareDrawer.getByRole("button", { name: "取消" }).click();
  await documentRow(page, name).getByRole("button", { name: "版本" }).click();
  const versionDrawer = page.locator(".collab-version-panel:visible");
  await versionDrawer.waitFor({ state: "visible", timeout: 15_000 });
  const versionWidth = await versionDrawer.boundingBox();
  const versionOverflow = await versionDrawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  check("390px 版本抽屉宽度自适应", Boolean(versionWidth && versionWidth.width <= mobileWidth + 1), JSON.stringify(versionWidth));
  check("390px 版本抽屉无横向溢出", versionOverflow);
  await versionDrawer.getByRole("button", { name: "关闭", exact: true }).click();
}

/**
 * 执行第 2 轮窄屏、异常输入、失败重试、公开访问和删除恢复流程。
 * @param {import("playwright").Page} page 管理员页面。
 * @param {{document: Record<string, unknown>, imported: Record<string, unknown>}} fixture 第 1 轮产生的文档。
 * @param {{expectResponse: Function, expectConsoleError: Function}} [observation] 当前页面错误观测器，用于区分主动构造的失败响应和真实故障。
 * @returns {Promise<Record<string, unknown>>} 第 2 轮产生的企业内公开文档。
 * @throws {Error} 关键异常恢复路径失败时抛出。
 */
async function runSecurityAndUxCycle(page, fixture, observation) {
  console.log("CYCLE_2_START mobile, error recovery and all operation columns");
  await page.setViewportSize({ width: mobileWidth, height: mobileHeight });
  await gotoCollab(page);
  await assertMobileTables(page, "第2轮协同表格");
  await assertOperationColumn(page, ".collab-page__table", "第2轮协同表格窄屏操作列", true);
  await assertChinesePagination(page, "第2轮协同表格窄屏");
  await testNarrowDrawers(page, fixture.document.name);
  await cancelDelete(page, fixture.document.name);
  await testInvalidImport(page, observation);

  let failOnce = true;
  observation?.expectResponse((response) => response.status() === 503 && response.url().includes("/api/collab/documents?"));
  observation?.expectConsoleError((text) => text.includes("status of 503") || text.includes("503 (Service Unavailable)"));
  await page.route("**/api/collab/documents?*", async (route) => {
    if (!failOnce) return route.continue();
    failOnce = false;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "TEST_RETRY", message: "测试失败" } }) });
  });
  await page.getByRole("button", { name: "刷新列表" }).click();
  await page.locator(".management-page__alert").waitFor({ state: "visible", timeout: 15_000 });
  check("列表失败显示中文重试提示", (await page.locator(".management-page__alert").innerText()).includes("刷新列表"));
  await page.unroute("**/api/collab/documents?*");
  await page.getByRole("button", { name: "刷新列表" }).click();
  await page.locator(".management-page__alert").waitFor({ state: "hidden", timeout: 15_000 });
  check("列表失败后点击刷新可以恢复", await documentRow(page, fixture.document.name).count() > 0);

  const publicName = `浏览器三轮公开-${testSuffix}`;
  const publicDocument = await createDocumentViaUi(page, publicName, true);
  await testNarrowDrawers(page, publicName);
  const publicRow = documentRow(page, publicName);
  await publicRow.getByRole("button", { name: "删除" }).click();
  const deleteBox = page.locator(".el-message-box:visible");
  await deleteBox.getByRole("button", { name: "确认删除" }).click();
  const deleteDeadline = Date.now() + 15_000;
  let deletedFromActiveList = false;
  while (Date.now() < deleteDeadline) {
    deletedFromActiveList = (await documentRow(page, publicName).count()) === 0;
    if (deletedFromActiveList) break;
    await page.waitForTimeout(250);
  }
  check("确认删除后正常列表隐藏文档", deletedFromActiveList);
  const statusSelect = page.locator(".collab-page__status-select");
  await statusSelect.click();
  await page.locator(".el-select-dropdown:visible .el-select-dropdown__item").filter({ hasText: "已删除" }).click();
  const deletedRow = documentRow(page, publicName);
  await deletedRow.waitFor({ state: "visible", timeout: 15_000 });
  await deletedRow.getByRole("button", { name: "恢复" }).click();
  const restoreBox = page.locator(".el-message-box:visible");
  check("恢复操作显示中文二次确认", (await restoreBox.innerText()).includes("恢复"));
  await restoreBox.getByRole("button", { name: "确认恢复" }).click();
  await waitDocument(page, publicName);
  await gotoCollab(page);
  const restoredRow = documentRow(page, publicName);
  let restoredRowVisible = false;
  try {
    await restoredRow.waitFor({ state: "visible", timeout: 15_000 });
    restoredRowVisible = true;
  } catch {
    restoredRowVisible = false;
  }
  check("确认恢复后文档回到正常列表", restoredRowVisible);
  const accountButton = page.getByRole("button", { name: "打开账户菜单" });
  await accountButton.click();
  const personalCenterButton = page.getByRole("button", { name: "个人中心", exact: true });
  await personalCenterButton.waitFor({ state: "visible", timeout: 5_000 });
  check("窄屏账户菜单入口可发现", await personalCenterButton.isVisible());
  await page.keyboard.press("Escape");
  console.log(`CYCLE_2_PASS public=${publicDocument.id}`);
  return publicDocument;
}

/**
 * 在两个实时编辑器页面中同时执行指定 Data 工具栏命令，并确认编辑器仍保持连接。
 * @param {import("playwright").Page} firstPage 第一个真实浏览器页面。
 * @param {import("playwright").Frame} firstFrame 第一个 ONLYOFFICE iframe。
 * @param {string} firstCommand 第一个用户的 aria-label 命令。
 * @param {import("playwright").Page} secondPage 第二个真实浏览器页面。
 * @param {import("playwright").Frame} secondFrame 第二个 ONLYOFFICE iframe。
 * @param {string} secondCommand 第二个用户的 aria-label 命令。
 * @returns {Promise<void>} 两个工具栏命令完成后兑现。
 */
async function runConcurrentOfficeCommands(firstPage, firstFrame, firstCommand, secondPage, secondFrame, secondCommand, firstLabel = "第一个编辑器", secondLabel = "第二个编辑器") {
  /**
   * 收敛 ONLYOFFICE 命令产生的确认层，避免排序确认框遮挡下一次 Data 工具栏操作。
   * 某些版本直接执行命令，某些版本会显示英文 OK/Cancel 对话框；优先确认可提交的
   * 对话框，找不到确认按钮时使用 Escape 关闭残留层，再等待遮罩真正消失。
   * @param {import("playwright").Page} page 承载 ONLYOFFICE 的业务页面。
   * @param {import("playwright").Frame} frame 当前 ONLYOFFICE iframe。
   * @param {string} label 当前编辑器的安全诊断标签。
   * @returns {Promise<void>} 当前命令的弹窗和遮罩收敛后兑现。
   */
  const settleOfficeCommand = async (page, frame, label) => {
    const visibleMask = frame.locator(".modals-mask").filter({ visible: true });
    if (!(await visibleMask.count())) return;
    const modalText = await visibleMask.last().innerText().catch(() => "");
    const modal = frame.locator(".modal-dialog:visible, .modals-mask:visible").last();
    const confirmButton = modal.locator("button:visible").filter({ hasText: /^(OK|确定|Apply|应用)$/i }).last();
    if (await confirmButton.count()) {
      await confirmButton.click().catch(() => undefined);
    } else {
      await frame.locator("body").press("Escape").catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const maskStillVisible = await frame.locator(".modals-mask").evaluateAll((elements) => elements.some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })).catch(() => false);
      if (!maskStillVisible) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`${label} ONLYOFFICE 命令弹窗未收敛：${modalText.replace(/\\s+/g, " ").slice(0, 240)}`);
  };

  const prepare = async (page, frame, label) => {
    await settleOfficeCommand(page, frame, label);
    const dataTab = frame.getByText(/^(Data|数据)$/, { exact: true }).last();
    try {
      await dataTab.waitFor({ state: "visible", timeout: 8_000 });
    } catch {
      const bodyText = await frame.locator("body").innerText().catch(() => "");
      const tabText = await frame.locator("[role=tab], button, [aria-label]").evaluateAll((elements) => elements.map((element) => ({
        text: String(element.textContent || "").replace(/\\s+/g, " ").trim(),
        aria: element.getAttribute("aria-label"),
        role: element.getAttribute("role"),
      })).filter((item) => item.text || item.aria).slice(0, 80)).catch(() => []);
      throw new Error(`${label} ONLYOFFICE Data 菜单未就绪; body=${bodyText.replace(/\\s+/g, " ").slice(0, 500)}; tabs=${JSON.stringify(tabText)}`);
    }
    await dataTab.click();
    await frame.locator("#ws-canvas-graphic-overlay").click({ position: { x: 85, y: 42 } });
  };
  await Promise.all([prepare(firstPage, firstFrame, firstLabel), prepare(secondPage, secondFrame, secondLabel)]);
  // ONLYOFFICE 在工具栏切换后会保留隐藏的同名按钮；只点击当前可见实例，避免测试误把
  // 隐藏节点当成用户可操作按钮而产生 30 秒定位超时。
  await Promise.all([
    officeCommandLocator(firstFrame, firstCommand).click(),
    officeCommandLocator(secondFrame, secondCommand).click(),
  ]);
  await Promise.all([
    settleOfficeCommand(firstPage, firstFrame, firstLabel),
    settleOfficeCommand(secondPage, secondFrame, secondLabel),
  ]);
  await firstPage.waitForTimeout(1_000);
  const firstConnected = (await firstPage.locator(".spreadsheet-shell").innerText()).includes("已连接");
  const secondConnected = (await secondPage.locator(".spreadsheet-shell").innerText()).includes("已连接");
  check("两个用户同时筛选/排序后第一个编辑器保持连接", firstConnected);
  check("两个用户同时筛选/排序后第二个编辑器保持连接", secondConnected);
}

/**
 * 返回本地化后的 ONLYOFFICE 工具栏命令定位器，兼容英文默认 aria-label 和简体中文界面标签。
 * @param {import("playwright").Frame} frame 当前 ONLYOFFICE spreadsheeteditor iframe。
 * @param {string} command 测试命令的英文稳定标识。
 * @returns {import("playwright").Locator} 当前可见的命令按钮定位器。
 * @throws {Error} command 不在测试支持的命令白名单中时抛出。
 */
function officeCommandLocator(frame, command) {
  const patterns = {
    "Sort ascending": /^(?:Sort ascending|升序(?:排序)?)$/i,
    "Sort descending": /^(?:Sort descending|降序(?:排序)?)$/i,
    "Filter (Ctrl+Shift+L)": /^(?:Filter(?: \(Ctrl\+Shift\+L\))?|筛选(?: \(Ctrl\+Shift\+L\))?)$/i,
  };
  const pattern = patterns[command];
  if (!pattern) throw new Error(`不支持的 ONLYOFFICE 测试命令：${command}`);
  return frame.getByRole("button", { name: pattern }).last();
}

/**
 * 确认 ONLYOFFICE 打开 CSV 时显示的编码/分隔符导入选项，避免该确认遮挡后续 Data 工具栏操作。
 * @param {import("playwright").Page} page 承载编辑器的业务页面，用于等待异步渲染。
 * @param {import("playwright").Frame} frame 当前 CSV 工作簿的 ONLYOFFICE iframe。
 * @param {string} label 当前浏览器用户标签。
 * @returns {Promise<void>} 对话框存在时确认并等待画布恢复；无对话框时直接返回。
 * @throws {Error} CSV 选项对话框出现但缺少确认按钮，或确认后画布未恢复时抛出。
 */
async function confirmOfficeCsvOptions(page, frame, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    // ONLYOFFICE 9.x 将 CSV 导入确认框的内容直接挂在 .modals-mask 下，不保证存在
    // 旧版本使用的 .modal-dialog 类；以可见标题和 OK 控件识别真实弹窗，避免版本耦合。
    const dialogOpen = await frame.locator("body").evaluate((element) => /Choose CSV options|选择.*CSV.*选项/i.test(element.innerText || "")).catch(() => false);
    if (dialogOpen) {
      const confirmButton = frame.getByRole("button", { name: /^(OK|确定)$/i }).last();
      await confirmButton.waitFor({ state: "visible", timeout: 5_000 });
      await confirmButton.click();
      await frame.locator("#ws-canvas-graphic-overlay").waitFor({ state: "visible", timeout: 30_000 });
      check(`${label} CSV 导入选项确认后画布可用`, true);
      return;
    }
    const maskOpen = await frame.locator(".modals-mask").evaluateAll((elements) => elements.some((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })).catch(() => false);
    if (!maskOpen && await frame.locator("#ws-canvas-graphic-overlay").isVisible().catch(() => false)) return;
    await page.waitForTimeout(250);
  }
  const diagnostic = await frame.locator("body").innerText().catch(() => "");
  const modalState = await frame.locator(".modal-dialog, .modals-mask").evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      className: String(element.className || "").slice(0, 160),
      text: String(element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160),
      display: style.display,
      visibility: style.visibility,
      width: rect.width,
      height: rect.height,
    };
  })).catch(() => []);
  const canvasState = await frame.locator("#ws-canvas-graphic-overlay").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { display: style.display, visibility: style.visibility, width: rect.width, height: rect.height };
  }).catch(() => null);
  throw new Error(`${label} CSV 导入选项或编辑画布未就绪; body=${diagnostic.replace(/\\s+/g, " ").slice(0, 320)}; modals=${JSON.stringify(modalState)}; canvas=${JSON.stringify(canvasState)}`);
}

/**
 * 执行第 3 轮双用户同单元格编辑、实时筛选排序、版本恢复和全页面操作列回归。
 * @param {import("playwright").Browser} browser Chromium 实例。
 * @param {import("playwright").Page} adminPage 已登录管理员页面。
 * @param {{document: Record<string, unknown>, imported: Record<string, unknown>}} fixture 第 1 轮文档。
 * @returns {Promise<void>} 并发、版本、页面布局和观测检查完成后兑现。
 * @throws {Error} 编辑成员登录或实时编辑关键路径失败时抛出。
 */
async function runConcurrencyCycle(browser, adminPage, fixture) {
  console.log("CYCLE_3_START two-browser editing, filter/sort and all-page regression");
  await adminPage.setViewportSize({ width: browserWidth, height: browserHeight });
  await gotoCollab(adminPage);
  const adminSession = dataOf(await browserApi(adminPage, "/api/auth/session"));
  const adminName = String(adminSession?.user?.name || adminSession?.user?.username || "管理员");
  const editorContext = await browser.newContext({ viewport: { width: browserWidth, height: browserHeight } });
  const editorPage = await loginPage(editorContext, resources.editor.username, resources.editor.password, "编辑成员");
  const editorObservation = attachObservability(editorPage);
  await gotoCollab(editorPage);
  await Promise.all([openOfficeDocument(adminPage, fixture.document.name), openOfficeDocument(editorPage, fixture.document.name)]);
  const [adminFrame, editorFrame] = await Promise.all([findOfficeFrame(adminPage), findOfficeFrame(editorPage)]);
  assert.ok(adminFrame && editorFrame, "两个用户均已加载 ONLYOFFICE iframe");
  await Promise.all([
    assertOfficeCollaborationConfig(adminPage, fixture.document.id, "第3轮管理员"),
    assertOfficeCollaborationConfig(editorPage, fixture.document.id, "第3轮编辑成员"),
  ]);
  const baseline = (await listDocuments(adminPage)).find((item) => item.id === fixture.document.id);
  const firstValue = `ADMIN_${testSuffix}`;
  const secondValue = `EDITOR_${testSuffix}`;
  await Promise.all([editOfficeCell(adminPage, adminFrame, firstValue), editOfficeCell(editorPage, editorFrame, secondValue)]);
  await Promise.all([
    assertRemoteSelectionName(adminPage, adminFrame, resources.editor.name, "管理员看到编辑成员"),
    assertRemoteSelectionName(editorPage, editorFrame, adminName, "编辑成员看到管理员"),
  ]);
  check("两个用户同时编辑同一单元格后均保持已连接", (await adminPage.locator(".spreadsheet-shell").innerText()).includes("已连接") && (await editorPage.locator(".spreadsheet-shell").innerText()).includes("已连接"));
  // ONLYOFFICE 在离页时异步发送 status=2 保存回调；两个页面同时导航前留出缓冲，
  // 保证测试验证的是并发保存结果而不是浏览器中断中的网络请求。
  await Promise.all([adminPage.waitForTimeout(2_500), editorPage.waitForTimeout(2_500)]);
  await Promise.all([
    adminPage.goto(`${browserBaseUrl}/home`, { waitUntil: "domcontentloaded", timeout: 30_000 }),
    editorPage.goto(`${browserBaseUrl}/home`, { waitUntil: "domcontentloaded", timeout: 30_000 }),
  ]);
  const saved = await (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = await browserApi(adminPage, `/api/collab/documents/${fixture.document.id}`);
      const document = dataOf(response);
      if (response.status === 200 && Number(document?.currentRevision) > Number(baseline?.currentRevision)) return document;
      await adminPage.waitForTimeout(1_000);
    }
    return null;
  })();
  check("双用户同单元格编辑至少产生一次安全保存修订", Boolean(saved));
  await gotoCollab(adminPage);
  const reopenedFrame = await openOfficeDocument(adminPage, fixture.document.name);
  await reopenedFrame.locator("#ws-canvas-graphic-overlay").click({ position: { x: 85, y: 42 } });
  const finalCellValue = await waitForOfficeCellValue(adminPage, reopenedFrame, [firstValue, secondValue]);
  check("双用户同单元格编辑最终内容非空且来自任一用户", finalCellValue.includes(firstValue) || finalCellValue.includes(secondValue), `最终值长度=${finalCellValue.length}`);
  await adminPage.goto(`${browserBaseUrl}/home`, { waitUntil: "domcontentloaded", timeout: 30_000 });

  await gotoCollab(adminPage);
  const adminDataFramePromise = openOfficeDocument(adminPage, fixture.imported.name);
  await gotoCollab(editorPage);
  const editorDataFramePromise = openOfficeDocument(editorPage, fixture.imported.name);
  const [adminDataFrame, editorDataFrame] = await Promise.all([adminDataFramePromise, editorDataFramePromise]);
  const [adminDataConfig, editorDataConfig] = await Promise.all([
    browserApi(adminPage, `/api/collab/documents/${fixture.imported.id}/editor-config`),
    browserApi(editorPage, `/api/collab/documents/${fixture.imported.id}/editor-config`),
  ]);
  const editorModes = [adminDataConfig, editorDataConfig].map((response) => {
    const editor = dataOf(response)?.editor;
    return { status: response.status, mode: editor?.config?.editorConfig?.mode || null, canEdit: editor?.config?.document?.permissions?.edit === true, fileType: editor?.config?.document?.fileType || null };
  });
  console.log(`CSV_EDITOR_MODES ${JSON.stringify(editorModes)}`);
  await Promise.all([
    confirmOfficeCsvOptions(adminPage, adminDataFrame, "管理员"),
    confirmOfficeCsvOptions(editorPage, editorDataFrame, "编辑成员"),
  ]);
  await runConcurrentOfficeCommands(adminPage, adminDataFrame, "Sort ascending", editorPage, editorDataFrame, "Sort descending", "管理员", "编辑成员");
  await runConcurrentOfficeCommands(adminPage, adminDataFrame, "Filter (Ctrl+Shift+L)", editorPage, editorDataFrame, "Filter (Ctrl+Shift+L)", "管理员", "编辑成员");
  await Promise.all([
    adminPage.goto(`${browserBaseUrl}/home`, { waitUntil: "domcontentloaded", timeout: 30_000 }),
    editorPage.goto(`${browserBaseUrl}/home`, { waitUntil: "domcontentloaded", timeout: 30_000 }),
  ]);

  for (const route of [
    ["/system/module", "模块管理"],
    ["/system/table", "数据表管理"],
    ["/system/organization", "组织管理"],
    ["/system/member", "成员管理"],
    ["/system/position", "岗位管理"],
    ["/system/online-member", "在线成员"],
  ]) {
    await adminPage.goto(`${browserBaseUrl}${route[0]}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await adminPage.waitForFunction((expectedText) => document.body?.innerText?.includes(expectedText), route[1], { timeout: 15_000 });
    const bodyText = await adminPage.locator("body").innerText();
    check(`第3轮页面可进入：${route[1]}`, bodyText.includes(route[1]) && !bodyText.includes("页面不存在"));
    await assertMobileTables(adminPage, `第3轮桌面页面 ${route[1]}`);
    if (await adminPage.locator(".el-table:visible").count()) {
      await assertOperationColumn(adminPage, ".el-table:visible", `第3轮 ${route[1]} 操作列`);
      await assertChinesePagination(adminPage, `第3轮 ${route[1]}`);
    }
  }
  await gotoCollab(adminPage);
  await transferDocumentOwnershipViaUi(adminPage, editorPage, fixture.imported.name, resources.editor);
  check("第二个浏览器页面未捕获 5xx", editorObservation.httpErrors.length === 0, JSON.stringify(editorObservation.httpErrors));
  check("第二个浏览器页面未捕获非预期控制台错误", editorObservation.consoleErrors.length === 0, editorObservation.consoleErrors.slice(0, 3).join(" | "));
  await editorContext.close();
  console.log(`CYCLE_3_PASS document=${fixture.document.id} imported=${fixture.imported.id}`);
}

/**
 * 将本次测试创建的文档、临时成员和岗位按安全顺序清理；清理失败不覆盖前面的测试结果。
 * @param {import("playwright").Page} page 已认证管理员页面。
 * @returns {Promise<void>} 所有清理请求尝试完成后兑现。
 */
async function cleanupResources(page) {
  const cleanupErrors = [];
  for (const documentId of [...new Set(resources.documents)]) {
    const response = await browserApi(page, `/api/collab/documents/${documentId}`, { method: "DELETE" }).catch((error) => ({ status: 0, text: error.message }));
    if (![204, 404].includes(response.status)) cleanupErrors.push(`document:${response.status}`);
  }
  for (const memberId of resources.members) {
    const response = await browserApi(page, `/api/organization/members/${memberId}`, { method: "PUT", body: { roleId: null, isDelete: true } }).catch((error) => ({ status: 0, text: error.message }));
    if (response.status !== 200) cleanupErrors.push(`member:${response.status}`);
  }
  for (const positionId of resources.positions) {
    const response = await browserApi(page, `/api/positions/${positionId}`, { method: "DELETE" }).catch((error) => ({ status: 0, text: error.message }));
    if (![204, 404].includes(response.status)) cleanupErrors.push(`position:${response.status}`);
  }
  check("浏览器回归测试资源已清理", cleanupErrors.length === 0, cleanupErrors.join(","));
}

/**
 * 运行三轮真实浏览器回归，输出可追踪的总计标记供测试报告引用。
 * @returns {Promise<void>} 三轮完成并清理资源后兑现；失败时设置非零退出码。
 */
async function main() {
  assert.ok(adminUsername && adminPassword, "INITIAL_ADMIN_USERNAME/PASSWORD are required");
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const context = await browser.newContext({ viewport: { width: browserWidth, height: browserHeight } });
  const page = await context.newPage();
  const observation = attachObservability(page);
  try {
    await page.goto(`${browserBaseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForTimeout(300);
    const loginText = await page.locator("body").innerText();
    check("第1轮登录空提交显示中文校验", loginText.includes("请输入账号") && loginText.includes("请输入密码"));
    await page.getByLabel("账号").fill(adminUsername);
    await page.getByLabel("密码").fill(adminPassword);
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForURL(/\/home/, { timeout: 30_000 });
    check("管理员真实浏览器登录成功", /\/home/.test(page.url()));
    await createEditorFixture(page);
    const businessFixture = await runBusinessCycle(page);
    const publicDocument = await runSecurityAndUxCycle(page, businessFixture, observation);
    void publicDocument;
    await runConcurrencyCycle(browser, page, businessFixture);
    check("主浏览器未捕获 5xx", observation.httpErrors.length === 0, JSON.stringify(observation.httpErrors));
    check("主浏览器未捕获非预期控制台错误", observation.consoleErrors.length === 0, observation.consoleErrors.slice(0, 3).join(" | "));
    if (!failures.length) console.log(`COLLAB_BROWSER_THREE_CYCLE_PASS total=${passed}`);
  } catch (error) {
    failures.push(error.message);
    console.error(`COLLAB_BROWSER_THREE_CYCLE_ERROR ${error.message}`);
  } finally {
    await page.goto(`${browserBaseUrl}/home`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    await cleanupResources(page).catch((error) => failures.push(`cleanup:${error.message}`));
    await context.close();
    await browser.close();
  }
  if (failures.length) {
    console.error(`COLLAB_BROWSER_THREE_CYCLE_FAIL count=${failures.length}`);
    failures.forEach((failure) => console.error(`FAILURE ${failure}`));
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`COLLAB_BROWSER_THREE_CYCLE_FATAL ${error.stack || error}`);
  process.exitCode = 1;
});

module.exports = { main };
