"use strict";

const assert = require("assert/strict");
const path = require("path");

/**
 * 在隔离视频企业内执行真实界面 CRUD、所有分屏数量、16路同时解码、个人视图与离页回收回归。
 * @param {object} context 必填，隔离管理员/组织/设备和模拟媒体端口。
 * @param {import("playwright").Page} page 必填，访问真实同源生产前端/隔离 BFF 且已登录管理员的 Edge 页面；不拦截接口。
 * @param {object} helpers 必填，camera、workspace、media、spawn、config、children、pass、delay 测试工具。
 * @returns {Promise<void>} 验证真实 UI 和视频后停止测试画面；失败由主脚本统一清理全部隔离资源。
 */
async function workspaceBrowserChecks(context, page, helpers) {
  const { camera, workspace, media, spawn, config, children, pass, delay } = helpers;
  const frontend = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  // 通过真实表单新增、编辑、删除一个空组织，验证类型/上级选择与中文确认流程。
  await page.goto(`${frontend}/camera/organizations`);
  await page.getByRole("heading", { name: "组织管理", exact: true }).waitFor();
  await page.getByRole("button", { name: "新增公司", exact: true }).click();
  await page.getByPlaceholder("请输入公司、组织或门店名称").fill("界面测试空公司");
  await page.getByRole("button", { name: "保存组织", exact: true }).click();
  await page.getByRole("dialog", { name: "新增视频组织" }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "编辑节点", exact: true }).click();
  await page.getByPlaceholder("请输入公司、组织或门店名称").fill("界面测试公司改名");
  await page.getByRole("button", { name: "保存组织", exact: true }).click();
  await page.getByRole("dialog", { name: "编辑视频组织" }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "删除空节点", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await page.getByText("组织已删除", { exact: true }).waitFor();
  // 平台原组织/成员与视频页面可同时存在，避免同名路由互相卸载。
  await page.goto(`${frontend}/system/organization`);
  await page.getByRole("heading", { name: "组织管理", exact: true }).waitFor();
  await page.goto(`${frontend}/camera/members`);
  await page.getByRole("heading", { name: "成员管理", exact: true }).waitFor();
  await page.getByPlaceholder("搜索登录账号、姓名或备注").fill("视频范围测试成员");
  await page.getByRole("button", { name: "编辑归属", exact: true }).click();
  await page.getByPlaceholder("选填，说明成员职责或授权原因").fill("浏览器编辑的视频授权备注");
  await page.getByRole("button", { name: "保存成员", exact: true }).click();
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await page.getByRole("dialog", { name: "编辑视频成员" }).waitFor({ state: "hidden" });
  await page.getByText("浏览器编辑的视频授权备注", { exact: true }).waitFor();
  pass("组织页面真实新增/修改/删除，成员授权编辑与跨模块同名路由共存");

  await page.goto(`${frontend}/camera/video`);
  await page.getByRole("heading", { name: "视频中心", exact: true }).waitFor();
  for (let count = 1; count <= 16; count += 1) {
    await page.getByRole("combobox", { name: "视频分屏数量" }).locator("xpath=ancestor::div[contains(@class,'el-select__wrapper')]").click();
    await page.getByRole("option", { name: `${count} 分屏`, exact: true }).click();
    await page.waitForFunction((expected) => document.querySelectorAll(".video-center__slot").length === expected, count);
    assert.equal(await page.locator(".video-center__slot").count(), count);
  }
  pass("真实浏览器逐一切换1至16分屏，画面槽位数与布局选择一致");
  if (!context.media) { process.stdout.write("SKIP 十六路真实视频：未安装本机测试媒体源\n"); return; }

  const publisher = spawn(config.camera.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=8", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-g", "16", "-t", "300", "-f", "rtsp", "-rtsp_transport", "tcp", `rtsp://${context.input.host}:${context.media.port}/mock`], { windowsHide: true, stdio: "ignore" });
  children.push(publisher);
  await delay(1000);
  for (let index = 1; index <= 16; index += 1) await camera.save(context.admin.auth, { ...context.input, name: `分屏测试${String(index).padStart(2, "0")}`, rtspPort: context.media.port, rtspPath: `/mock?channel=${index}`, recordingEnabled: false, organizationId: context.store.id });
  await page.getByRole("button", { name: "刷新设备", exact: true }).click();
  await page.getByRole("button", { name: "播放分屏测试16", exact: true }).waitFor();
  await page.locator(".video-center__organizations .el-tree-node__content").filter({ hasText: context.store.name }).click();
  await page.getByRole("button", { name: "播放当前组织", exact: true }).click();
  try {
    await page.waitForFunction(() => {
      const videos = [...document.querySelectorAll(".video-center__slot video")];
      return videos.length === 16 && videos.every((video) => !video.error && !video.paused && video.videoWidth > 0 && video.readyState >= 2) && [...document.querySelectorAll(".video-tile__footer > span:first-child")].every((span) => span.textContent === "正在播放");
    }, undefined, { timeout: 100000 });
    const previousTimes = await page.locator(".video-center__slot video").evaluateAll((videos) => videos.map((video) => video.currentTime));
    for (let index = 0; index < 10; index += 1) await delay(1000);
    assert.ok(await page.locator(".video-center__slot video").evaluateAll((videos, times) => videos.length === 16 && videos.every((video, index) => !video.error && !video.paused && video.currentTime > times[index] + 5), previousTimes));
  } catch (error) {
    process.stderr.write(JSON.stringify(await page.locator(".video-center__slot").evaluateAll((tiles) => tiles.map((tile) => { const video = tile.querySelector("video"); return { state: tile.querySelector(".video-tile__footer")?.textContent, code: video?.error?.code, error: video?.error?.message, currentTime: video?.currentTime, readyState: video?.readyState, paused: video?.paused }; }))) + "\n");
    throw error;
  }
  const sessions = await media.activePreviewCount(context.admin.auth);
  assert.equal(sessions, 16);
  pass("16个不同设备通道同时经过真实RTSP/FFmpeg/HLS，并在浏览器全部解码");
  await page.screenshot({ path: path.resolve("../docs/camera-video-center-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "保存视图", exact: true }).click();
  await page.locator(".el-message-box__input input").fill("十六屏值守");
  await page.getByRole("button", { name: "保存视图", exact: true }).last().click();
  await page.getByText("监控视图已保存", { exact: true }).waitFor();
  assert.ok((await workspace.views(context.admin.auth)).some((view) => view.name === "十六屏值守" && view.screens === 16 && view.devices.filter(Boolean).length === 16));
  await page.getByRole("button", { name: "全部暂停", exact: true }).click();
  for (let attempt = 0; attempt < 30; attempt += 1) { if (await media.activePreviewCount(context.admin.auth) === 0) break; await delay(200); }
  assert.equal(await media.activePreviewCount(context.admin.auth), 0);
  await page.getByRole("button", { name: "全部播放", exact: true }).click();
  await page.waitForFunction(() => { const videos = [...document.querySelectorAll(".video-center__slot video")]; return videos.length === 16 && videos.every((video) => video.videoWidth > 0 && video.readyState >= 2); }, undefined, { timeout: 100000 });
  await page.getByRole("button", { name: "中心全屏", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await page.locator(".video-center").getByRole("button", { name: "退出全屏", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2));
  await page.screenshot({ path: path.resolve("../docs/camera-video-center-mobile.png"), fullPage: true });
  // 整页刷新也必须释放已播放的16路，随后从服务端恢复个人视图，再验证启动中离页取消。
  await page.goto(`${frontend}/camera/video`);
  await page.getByRole("heading", { name: "视频中心", exact: true }).waitFor();
  for (let attempt = 0; attempt < 50; attempt += 1) { if (await media.activePreviewCount(context.admin.auth) === 0) break; await delay(200); }
  assert.equal(await media.activePreviewCount(context.admin.auth), 0);
  pass("个人16屏视图保存、全部暂停/恢复、中心全屏、390px窄屏与整页刷新释放");
  await page.getByRole("combobox", { name: "个人监控视图" }).locator("xpath=ancestor::div[contains(@class,'el-select__wrapper')]").click();
  await page.getByRole("option", { name: "十六屏值守 · 16屏", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".video-center__slot").length === 16);
  await delay(1000);
  await page.goto(`${frontend}/camera/organizations`);
  await page.getByRole("heading", { name: "组织管理", exact: true }).waitFor();
  for (let attempt = 0; attempt < 12; attempt += 1) await delay(1000);
  assert.equal(await media.activePreviewCount(context.admin.auth), 0);
  pass("个人视图跨刷新恢复16屏与启动中的画面请求离页取消");
}

module.exports = { workspaceBrowserChecks };
