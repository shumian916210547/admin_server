"use strict";

// 对已构建 SPA 执行隔离浏览器回归；全部 /api 响应在浏览器拦截，禁止连接真实数据库或账号。
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");
const baseUrl = process.env.ADMIN_UI_TEST_URL || "http://localhost:4200";
const screenshotDirectory = process.env.ADMIN_UI_SCREENSHOT_DIR;
const permissionCodes = ["query", "reset", "preview", "insert", "edit", "remove", "export"].map((action) => `permission:${action}`);
const fields = {
  objectId: { type: "String", chineseName: "对象 ID", isTable: true },
  name: { type: "String", chineseName: "名称", editComponent: "ElInput", required: true, isTable: true, isFilter: true },
  note: { type: "String", chineseName: "备注", editComponent: "ElInput", isTable: true },
  active: { type: "Boolean", chineseName: "启用状态", editComponent: "ElSwitch", isFilter: true, isTable: true, defaultValue: false },
  at: { type: "Date", chineseName: "时间", editComponent: "ElDatePicker", isTable: true, isFilter: true },
  body: { type: "String", chineseName: "说明", editComponent: "RichTextEditor" },
};
const auth = {
  user: { objectId: "qa-member", name: "测试成员", username: "fixture", role: { className: "Role", objectId: "qa-role" }, systemOptions: {} },
  company: { objectId: "qa-company", name: "界面回归演示" },
  role: { objectId: "qa-role", module: [{ objectId: "qa-module" }, { objectId: "qa-rows" }, { objectId: "qa-other" }] },
  isAdmin: false,
  csrfToken: "isolated-fixture",
};

/** @param {number} ms 必填，毫秒。 @returns {Promise<void>} 有界异步延迟，用于主动制造响应乱序。 */
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * 为一个浏览器页面安装内存 BFF，记录查询/写入并模拟慢响应和业务失败。
 * @param {import("playwright").Page} page 必填，隔离页面。
 * @param {string} [appearance="light"] 可选，真实偏好中的明暗模式；dark 同时测试纵向布局。
 * @returns {Promise<object>} 测试控制状态；所有修改只存在于内存。
 */
async function installFixtures(page, appearance = "light") {
  const session = { ...auth, user: { ...auth.user, systemOptions: { theme: appearance, layout: appearance === "dark" ? "LeftLayout" : "TopLayout" } } };
  const state = { queries: [], writes: [], failSave: false, failQuery: false, rows: Array.from({ length: 23 }, (_, index) => ({
    objectId: `row-${index + 1}`, name: `记录 ${String(index + 1).padStart(2, "0")}`, note: null, active: false,
    at: "2026-11-01T12:00:00.000Z", body: "测试说明", createdAt: "2026-11-01T12:00:00.000Z",
  })) };
  // 不让 PWA 缓存绕过模拟 API；外部资源不属于本次回归。
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    /** @param {unknown} data 必填，业务数据。 @param {number} [status=200] 可选，HTTP 状态。 @returns {Promise<void>} 返回统一 JSON。 */
    const respond = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(status >= 400 ? { error: { message: "模拟服务失败" } } : { data }) });
    if (pathname.startsWith("/api/auth/")) return respond(session);
    if (pathname === "/api/data/query") {
      const input = body;
      if (input.className === "Module") return respond({ data: [{ objectId: "qa-module", name: "回归业务", path: "regression", menu: true, routes: [
        { objectId: "qa-rows", name: "测试记录", path: "rows", menu: true, targetClass: "RegressionRecord", pageComponent: "/Wrapper" },
        { objectId: "qa-other", name: "另一张表", path: "other", menu: true, targetClass: "AlternateRecord", pageComponent: "/Wrapper" },
      ] }], count: 1 });
      if (input.className === "Schema") return respond({ data: [{ objectId: "schema", nickName: "测试记录", fields }], count: 1 });
      if (input.className === "AllotPermission") return respond({ data: [{ objectId: "permission", permissions: permissionCodes }], count: 1 });
      state.queries.push(input);
      const keyword = input.filters.find((item) => item.field === "name")?.value || "";
      if (keyword === "slow") await delay(400);
      if (state.failQuery) return respond(null, 500);
      let rows = keyword === "slow" || keyword === "fast" ? [{ ...state.rows[0], name: `${keyword} result` }]
        : state.rows.filter((row) => row.name.includes(keyword));
      const id = input.filters.find((item) => item.field === "objectId")?.value;
      if (id) rows = rows.filter((row) => row.objectId === id);
      return respond({ data: rows.slice(input.skip || 0, (input.skip || 0) + (input.limit || 500)), count: rows.length });
    }
    if (pathname.startsWith("/api/data/")) {
      if (request.method() === "DELETE") {
        state.rows = state.rows.filter((row) => row.objectId !== pathname.split("/").at(-1));
        return respond(null);
      }
      state.writes.push(body);
      await delay(250);
      if (state.failSave) return respond(null, 500);
      const row = { ...body.attributes, objectId: "new-record" };
      state.rows.unshift(row);
      return respond(row);
    }
    return respond({});
  });
  return state;
}

/**
 * 验证视口中弹窗、分页及横向页面边界，截图仅包含内存构造的演示数据。
 * @param {import("playwright").Page} page 必填，当前页面。
 * @param {string} name 必填，安全截图文件名。
 * @returns {Promise<void>} 超界时抛出断言；配置目录时写脱敏截图。
 */
async function checkViewport(page, name) {
  await delay(200);
  // 清理本用例主动触发的错误/校验通知，截图只验证稳定界面。
  await page.locator(".el-notification__closeBtn").evaluateAll((nodes) => {
    nodes.forEach((node) => node.click());
  });
  await page.waitForFunction(() => !document.querySelector(".el-notification"));
  const sizes = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  assert(sizes.content <= sizes.width + 1, `${name} 页面不应横向溢出`);
  const dialog = page.locator(".el-dialog:visible");
  if (await dialog.count()) {
    const box = await dialog.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= sizes.width + 1, `${name} 弹窗在视口内`);
    await assert.doesNotReject(() => dialog.getByRole("button", { name: "确认", exact: true }).scrollIntoViewIfNeeded());
  }
  if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true });
}

/** @returns {Promise<void>} 执行真实 Chromium 交互、异常和响应式回归；finally 释放浏览器资源。 */
async function main() {
  const browser = await chromium.launch({ headless: true,
    channel: process.env.ADMIN_UI_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = await installFixtures(page);
    await page.goto(`${baseUrl}/regression/rows`);
    await page.getByRole("button", { name: "新建", exact: true }).waitFor();
    await page.locator(".el-table__body-wrapper").getByText("记录 01", { exact: true }).waitFor();
    assert.equal(state.queries.length, 1);
    console.log("PASS 刷新动态深链接并恢复会话，列表单次查询");

    await page.locator(".el-pager").getByText("3", { exact: true }).click();
    await page.getByText("记录 21", { exact: true }).waitFor();
    await page.getByPlaceholder("请输入名称", { exact: true }).fill("01");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByText("记录 01", { exact: true }).waitFor();
    assert.equal(state.queries.at(-1).skip, 0);
    await page.getByRole("button", { name: "重置", exact: true }).click();
    await page.getByText("记录 02", { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder("请输入名称", { exact: true }).inputValue(), "");
    console.log("PASS 第三页筛选回到第一页，重置清空筛选及旧引用");

    await page.getByPlaceholder("请输入名称", { exact: true }).fill("slow");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByPlaceholder("请输入名称", { exact: true }).fill("fast");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByText("fast result", { exact: true }).waitFor();
    await delay(500);
    assert.equal(await page.getByText("slow result", { exact: true }).count(), 0);
    state.failQuery = true;
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByText("数据加载失败", { exact: true }).waitFor();
    assert.equal(await page.getByText("fast result", { exact: true }).count(), 1);
    state.failQuery = false;
    await page.getByRole("button", { name: "重置", exact: true }).click();
    console.log("PASS 慢响应不能覆盖新结果，查询失败保留已有数据");

    await page.getByText("记录 02", { exact: true }).waitFor();
    await page.getByRole("button", { name: "修改", exact: true }).first().click();
    let dialog = page.locator(".common-form-modal:visible");
    await dialog.getByPlaceholder("请输入名称", { exact: true }).waitFor();
    assert.equal(await dialog.getByPlaceholder("请输入备注", { exact: true }).inputValue(), "");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await dialog.getByText("请输入名称", { exact: true }).waitFor();
    assert.equal(state.writes.length, 0);
    await dialog.getByPlaceholder("请输入名称", { exact: true }).fill("新建测试");
    state.failSave = true;
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await page.getByText("操作未完成", { exact: true }).waitFor();
    assert.equal(await dialog.getByPlaceholder("请输入名称", { exact: true }).inputValue(), "新建测试");
    state.failSave = false;
    const writeCount = state.writes.length;
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    assert(await dialog.getByRole("button", { name: "取消", exact: true }).isDisabled());
    await dialog.waitFor({ state: "hidden" });
    assert.equal(state.writes.length, writeCount + 1);
    console.log("PASS 空值编辑、必填校验、保存失败保留输入、保存中禁用操作");

    await page.getByRole("button", { name: "新建", exact: true }).click();
    assert.equal(await dialog.getByPlaceholder("请输入名称", { exact: true }).inputValue(), "");
    await checkViewport(page, "admin-form-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await checkViewport(page, "admin-form-mobile");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await checkViewport(page, "admin-list-mobile");
    await page.setViewportSize({ width: 390, height: 600 });
    await checkViewport(page, "admin-list-short-screen");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await checkViewport(page, "admin-list-desktop");
    const darkContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce" });
    const darkPage = await darkContext.newPage();
    await installFixtures(darkPage, "dark");
    await darkPage.goto(`${baseUrl}/regression/rows`);
    await darkPage.getByRole("button", { name: "新建", exact: true }).click();
    assert.equal(await darkPage.locator("html").getAttribute("data-app-theme"), "dark");
    await checkViewport(darkPage, "admin-form-mobile-dark");
    await darkPage.locator(".common-form-modal:visible").getByRole("button", { name: "取消", exact: true }).click();
    await checkViewport(darkPage, "admin-list-mobile-dark");
    await darkContext.close();
    console.log("PASS 新增重新初始化，桌面/390px 手机/短屏及真实深色偏好、横纵布局无横向溢出");

    state.rows = state.rows.slice(0, 21);
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.locator(".el-pager").getByText("3", { exact: true }).click();
    await page.locator(".el-table__body-wrapper .el-table__row").first().getByRole("button", { name: "删除", exact: true }).click();
    const previousPageResponse = page.waitForResponse((response) => {
      if (!response.url().endsWith("/api/data/query")) return false;
      const input = response.request().postDataJSON();
      return input.className === "RegressionRecord" && input.skip === 10;
    });
    await page.locator(".el-popconfirm:visible").getByRole("button", { name: "删除", exact: true }).click();
    await previousPageResponse;
    await page.waitForFunction(() => document.querySelector(".el-pager .is-active")?.textContent === "2");
    assert.equal(state.queries.at(-1).skip, 10);
    console.log("PASS 删除末页唯一记录后校正为上一页");

    await page.getByRole("button", { name: "查看", exact: true }).first().click();
    await page.locator(".common-preview:visible").waitFor();
    await page.locator(".common-preview:visible").getByRole("button", { name: /关闭|Close this dialog/ }).click();
    await page.getByRole("button", { name: "导出", exact: true }).click();
    dialog = page.locator(".el-dialog:visible");
    await dialog.locator(".el-table__body-wrapper .el-checkbox").first().click();
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    assert((await download).suggestedFilename().endsWith(".csv"));
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await dialog.getByRole("button", { name: "确认", exact: true }).click();
    await page.getByText("请先选择需要导出的记录", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByText("回归业务", { exact: true }).hover();
    await page.getByText("另一张表", { exact: true }).click();
    await page.waitForURL(/\/regression\/other$/);
    await page.getByRole("button", { name: "新建", exact: true }).waitFor();
    assert.equal(state.queries.at(-1).className, "AlternateRecord");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS 详情可用，CSV 下载成功，重新导出不沿用旧选择，切换数据表刷新 Schema；无未捕获页面异常");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
