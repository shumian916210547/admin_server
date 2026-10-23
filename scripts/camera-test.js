"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const express = require("express");
const { spawn } = require("child_process");

/** 测试只使用随机临时存储、随机加密密钥与两个新建 Company，不读取或扫描真实摄像头。 */
const host = Object.values(os.networkInterfaces()).flat().find((item) => item && !item.internal && item.family === "IPv4" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
const temporary = path.resolve(os.tmpdir(), `shumian-camera-test-${crypto.randomUUID()}`);
process.env.CAMERA_STORAGE_DIR = temporary;
process.env.CAMERA_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.CAMERA_ALLOWED_CIDRS = `${host}/32`;
const { config } = require("../config/env");
const Parse = require("parse/node");
const camera = require("../services/camera.service");
const media = require("../services/camera-media.service");
const network = require("../services/camera-network.service");
const replay = require("../services/camera-replay.service");
const db = require("../services/camera-db.service");
const workspace = require("../services/camera-workspace.service");
const { ensureSystemConfiguration } = require("../services/system-configuration.service");
const { createPublicApp } = require("../app-factory");
const { createSession } = require("../services/auth.service");
const { getAuthContext, master, pointer } = require("../services/parse-data.service");
// 安全拒绝用例会产生大量预期 HTTP 日志；测试仅输出断言名，失败仍保留断言堆栈。
const logger = require("../lib/logger");
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

const fixtures = [];
const children = [];
const servers = [];
let passed = 0;
let base;
let companyA;
let companyB;
let browser;

/**
 * 记录安全测试名，不输出 Cookie、密码、设备地址或数据库连接。
 * @param {string} label 必填，测试说明。
 * @returns {void} 增加计数并打印通过结果。
 */
function pass(label) { passed += 1; process.stdout.write(`PASS ${label}\n`); }

/**
 * 有界等待，用于网络进程就绪，不阻塞 Node 事件循环。
 * @param {number} milliseconds 必填，毫秒，单次不超过 1000。
 * @returns {Promise<void>} 延时完成。
 */
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/**
 * 在测试私网网卡启动一个随机 TCP 端口服务器。
 * @param {import("net").Server} server 必填，HTTP 或 TCP 测试服务。
 * @param {string} [address="127.0.0.1"] 可选，监听地址。
 * @returns {Promise<number>} 监听端口；保存服务器供 finally 关闭。
 */
async function listen(server, address = "127.0.0.1") { servers.push(server); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, address, resolve); }); return server.address().port; }

/**
 * 创建仅用于本轮测试的 Parse 对象并登记清理。
 * @param {string} className 必填，现有测试目标类。
 * @param {object} attributes 必填，脱敏测试字段。
 * @returns {Promise<Parse.Object>} 已保存对象；写隔离测试数据。
 */
async function record(className, attributes) { const object = new Parse.Object(className); await object.save(attributes, master); fixtures.push(object); return object; }

/**
 * 创建隔离成员并签发真实 Cookie 会话；不使用真实管理员账号。
 * @param {Parse.Object} company 必填，本轮创建的测试 Company。
 * @param {boolean} admin 必填，是否加入该 Company 管理员数组。
 * @param {Parse.Object} [role] 可选，测试岗位。
 * @returns {Promise<object>} 内存中的 Cookie、CSRF、用户和可信会话上下文；不得写日志。
 */
async function member(company, admin, role) {
  const user = new Parse.User();
  await user.save({ username: `camera-test-${crypto.randomUUID()}`, password: crypto.randomBytes(24).toString("hex"), company: pointer("Company", company.id), ...(role ? { role: pointer("Role", role.id) } : {}) }, master);
  fixtures.push(user);
  if (admin) { company.addUnique("admin", pointer("_User", user.id)); await company.save(null, master); }
  const session = createSession(user.id);
  return { cookie: `${config.auth.cookieName}=${session.token}`, csrf: session.csrfToken, token: session.token, user, auth: await getAuthContext(user.id) };
}

/**
 * 请求测试 BFF，默认携带真实会话和 CSRF，不自动跟随重定向。
 * @param {object|null} client 必填，测试成员或 null（匿名）。
 * @param {string} method 必填，HTTP 方法。
 * @param {string} route 必填，/api 下路径。
 * @param {object} [body] 可选，JSON 请求体。
 * @param {object} [headers={}] 可选，测试覆盖的请求头，例如 Range 或错误 CSRF。
 * @returns {Promise<object>} 状态、JSON/字节与响应头；不输出响应内的凭据。
 */
async function request(client, method, route, body, headers = {}) {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(client ? { Cookie: client.cookie, "X-CSRF-Token": client.csrf } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(bytes.toString()) : null, bytes };
}

/**
 * 验证私网边界、加密、时间区间和 RTSP 拆帧，包含真实 TCP 回放桥的认证/UTC Range 改写。
 * @returns {Promise<void>} 无真实设备访问，使用本机私网模拟 RTSP 服务。
 */
async function unitChecks() {
  assert.equal(network.validateHost(host), host);
  for (const address of ["127.0.0.1", "169.254.169.254", "8.8.8.8", "localhost", "::1", "192.168.222.222"]) if (address !== host) assert.throws(() => network.validateHost(address));
  assert.throws(() => network.deviceUrl("http://127.0.0.1/onvif", host));
  assert.throws(() => camera.rtspPath("//127.0.0.1/private"));
  assert.throws(() => camera.rtspPath("/camera%0d%0aAuthorization:bad"));
  pass("私网 CIDR、设备服务同地址和 RTSP 路径边界");
  const credentials = { username: "test-device", password: crypto.randomBytes(16).toString("hex") };
  const encrypted = camera.encrypt(credentials);
  assert.deepEqual(camera.decrypt(encrypted), credentials);
  assert.ok(!encrypted.includes(credentials.password));
  assert.notEqual(camera.encrypt(credentials), encrypted);
  assert.throws(() => camera.decrypt(`${encrypted}corrupted`));
  pass("AES-GCM 随机 IV、往返解密和篡改拒绝");
  assert.throws(() => media.timeRange({ start: "2026-10-01", end: "2026-10-02" }));
  assert.throws(() => media.timeRange({ start: "2026-01-01T00:00:00Z", end: "2026-01-01T02:00:00Z" }));
  pass("设备回放时区与单次一小时限制");
  const frames = [];
  const reader = replay.frameReader((frame, binary) => frames.push({ frame, binary }));
  const packet = Buffer.from([36, 0, 0, 3, 0, 255, 36]);
  const messages = Buffer.concat([Buffer.from("RTSP/1.0 200 OK\r\nContent-Length: 3\r\n\r\nabc"), packet]);
  for (let index = 0; index < messages.length; index += 2) reader(messages.subarray(index, index + 2));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1].frame, packet);
  pass("RTSP 分包重组与二进制 RTP 不被文本改写");
  let received;
  const rtspServer = net.createServer((socket) => {
    socket.on("data", replay.frameReader((frame, binary) => {
      if (binary) return;
      received = frame.toString();
      if (!received.includes("Authorization:")) socket.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="test", nonce="abc", qop="auth"\r\n\r\n');
      else socket.write("RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n");
    }));
  });
  const port = await listen(rtspServer, host);
  const bridge = await replay.createReplayBridge(`rtsp://${host}:${port}/replay`, credentials, { start: "2026-01-01T01:00:00.000Z", end: "2026-01-01T01:10:00.000Z" });
  const local = new URL(bridge.url);
  const socket = net.connect(Number(local.port), "127.0.0.1");
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("RTSP bridge timeout")), 3000);
      let responseCount = 0;
      socket.on("data", () => { responseCount += 1; if (responseCount === 1) socket.write(`PLAY rtsp://${local.host}/replay RTSP/1.0\r\nCSeq: 2\r\nAuthorization: Digest username="test"\r\nRange: npt=0-\r\n\r\n`); else { clearTimeout(timer); resolve(); } });
      socket.write(`PLAY rtsp://${local.host}/replay RTSP/1.0\r\nCSeq: 1\r\nRange: npt=0-\r\n\r\n`);
    });
    assert.ok(received.includes(`PLAY rtsp://${host}:${port}/replay`));
    assert.ok(received.includes("Range: clock=20260101T010000Z-20260101T011000Z"));
    assert.ok(received.includes(`uri="rtsp://${host}:${port}/replay"`));
    assert.ok(received.includes("Require: onvif-replay"));
    assert.ok(!received.includes("npt="));
    pass("ONVIF Profile G 回放桥重算 Digest 并使用绝对 UTC Range");
  } finally { socket.destroy(); bridge.close(); }
}

/**
 * 对新建隔离租户做真实 HTTP 权限、CSRF、封面、凭据脱敏和 Range 录像回放回归。
 * @returns {Promise<object>} 后续媒体测试使用的 admin、viewer 与 cameraId。
 */
async function apiChecks() {
  companyA = await record("Company", { name: "摄像头隔离测试 A" });
  companyB = await record("Company", { name: "摄像头隔离测试 B" });
  const route = await record("Route", { company: pointer("Company", companyA.id), systemKey: "system.camera", name: "摄像头管理", path: "camera", targetClass: "CameraDevice", pageComponent: "/system/camera/index" });
  const role = await record("Role", { company: pointer("Company", companyA.id), name: "摄像头测试只读", positionManaged: true, module: [pointer("Route", route.id)] });
  await record("AllotPermission", { company: pointer("Company", companyA.id), role: pointer("Role", role.id), routes: [pointer("Route", route.id)], permissions: ["permission:query"], positionManaged: true });
  const admin = await member(companyA, true);
  const other = await member(companyB, true);
  const viewer = await member(companyA, false, role);
  await ensureSystemConfiguration(admin.auth);
  const root = await workspace.saveOrganization(admin.auth, { name: "测试公司", type: "company", parentId: null, code: "ROOT", rank: 0, isActive: true, remark: "隔离测试" });
  const group = await workspace.saveOrganization(admin.auth, { name: "测试区域", type: "organization", parentId: root.id, code: "REGION", rank: 1, isActive: true, remark: "" });
  const store = await workspace.saveOrganization(admin.auth, { name: "测试门店", type: "store", parentId: group.id, code: "STORE", rank: 1, isActive: true, remark: "" });
  await workspace.saveMember(admin.auth, { userId: viewer.user.id, organizationId: store.id, includeDescendants: false, isActive: true, remark: "原设备回归只读成员" });
  // 在同一个临时源真实提供生产前端和BFF，避免接口拦截掩盖整页离开后的keepalive清理。
  const application = express();
  const frontendDirectory = path.resolve("../vue_admin/dist");
  application.use(express.static(frontendDirectory));
  application.get(/^\/(?!api(?:\/|$)|healthz$).*$/, (req, res) => res.sendFile(path.join(frontendDirectory, "index.html")));
  application.use(createPublicApp());
  base = `http://127.0.0.1:${await listen(http.createServer(application))}`;
  config.allowedOrigins.push(base);
  assert.equal((await request(null, "GET", "/cameras")).status, 401);
  const input = { name: "隔离测试摄像头", host, brand: "generic", onvifPort: 80, rtspPort: 554, rtspPath: "/test", username: "test", password: crypto.randomBytes(20).toString("hex"), location: "模拟实验室", recordingEnabled: false, organizationId: store.id };
  assert.equal((await request(admin, "POST", "/cameras", input, { "X-CSRF-Token": "invalid" })).status, 403);
  assert.equal((await request(viewer, "POST", "/cameras", input)).status, 403);
  const saved = await request(admin, "POST", "/cameras", { ...input, companyId: companyB.id });
  assert.equal(saved.status, 201);
  const id = saved.body.data.id;
  assert.equal((await request(other, "GET", `/cameras/${id}`)).status, 404);
  assert.equal((await request(other, "PUT", `/cameras/${id}`, input)).status, 404);
  assert.equal((await request(other, "GET", `/cameras/${id}/recordings`)).status, 404);
  assert.equal((await request(viewer, "GET", "/cameras")).status, 200);
  const list = await request(admin, "GET", "/cameras");
  assert.equal(list.body.data.devices.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(input.password));
  assert.ok(!JSON.stringify(list.body).includes("credentials"));
  assert.equal((await db.query("SELECT company_id FROM camera.devices WHERE id=$1", [id])).rows[0].company_id, companyA.id);
  assert.equal((await request(admin, "POST", "/cameras", input)).status, 409);
  const disposable = await request(admin, "POST", "/cameras", { ...input, name: "设备删除回归", rtspPath: "/disposable" });
  assert.equal(disposable.status, 201);
  assert.equal((await request(admin, "DELETE", `/cameras/${disposable.body.data.id}`, undefined, { "X-CSRF-Token": "invalid" })).status, 403);
  assert.equal((await request(admin, "DELETE", `/cameras/${disposable.body.data.id}`)).status, 200);
  assert.equal((await request(admin, "GET", `/cameras/${disposable.body.data.id}`)).status, 404);
  pass("真实 HTTP 登录边界、CSRF、只读岗位、跨租户及伪造 companyId 拒绝");
  pass("设备真实HTTP创建/查询/修改/删除与删除CSRF校验");
  const details = (await request(admin, "GET", `/cameras/${id}`)).body.data;
  assert.equal(details.password, "");
  await request(admin, "PUT", `/cameras/${id}`, { ...details, name: "重命名测试", password: "" });
  assert.equal(camera.decrypt((await camera.get(admin.auth, id)).credentials).password, input.password);
  pass("设备重命名和编辑空密码保留，列表与详情不泄露密钥");
  const cover = { type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK3sAAAAASUVORK5CYII=" };
  assert.equal((await request(admin, "PUT", `/cameras/${id}/cover`, { type: "image/png", data: Buffer.from("<svg>invalid</svg>").toString("base64") })).status, 400);
  assert.equal((await request(admin, "PUT", `/cameras/${id}/cover`, cover)).status, 200);
  assert.equal((await request(other, "GET", `/cameras/${id}/cover`)).status, 404);
  assert.equal((await request(viewer, "GET", `/cameras/${id}/cover`)).headers.get("cache-control"), "private, no-store");
  assert.equal((await request(admin, "PUT", `/cameras/${id}/cover`, { clear: true })).status, 200);
  pass("封面签名白名单、租户保护与清除封面");
  const directory = path.join(temporary, "recordings", id);
  await fs.mkdir(directory, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomUUID()}.mp4`;
  await fs.writeFile(path.join(directory, filename), Buffer.alloc(1024, 7));
  const range = await request(viewer, "GET", `/cameras/${id}/recordings/${filename}`, undefined, { Range: "bytes=10-19" });
  assert.equal(range.status, 206);
  assert.equal(range.bytes.length, 10);
  assert.equal((await request(other, "GET", `/cameras/${id}/recordings/${filename}`)).status, 404);
  pass("服务器录像列表与 HTTP Range 拖动回放鉴权");
  return { admin, viewer, other, id, input, root, group, store };
}

/**
 * 验证独立视频模块的树、成员、组织范围、批量归属、个人视图和并发移动，不用界面假设替代权限断言。
 * @param {object} context 必填，apiChecks 的隔离管理员、设备和初始组织。
 * @returns {Promise<void>} 写入的全部数据属于本轮隔离 Company，finally 统一清理。
 */
async function workspaceChecks(context) {
  const { admin, viewer, other, root, group, store, id, input } = context;
  const orgBody = { name: "边界测试", type: "organization", parentId: root.id, code: "", rank: 0, isActive: true, remark: "" };
  assert.equal((await request(admin, "POST", "/camera-workspace/organizations", { ...orgBody, type: "other" })).status, 400);
  assert.equal((await request(admin, "POST", "/camera-workspace/organizations", { ...orgBody, parentId: store.id })).status, 400);
  assert.equal((await request(admin, "PUT", `/camera-workspace/organizations/${group.id}`, { ...orgBody, parentId: group.id })).status, 400);
  assert.equal((await request(admin, "DELETE", `/camera-workspace/organizations/${store.id}`)).status, 409);
  assert.equal((await request(viewer, "POST", "/camera-workspace/organizations", orgBody)).status, 403);
  const branch = await workspace.saveOrganization(admin.auth, { ...orgBody, name: "其他区域", code: "OTHER" });
  const otherStore = await workspace.saveOrganization(admin.auth, { ...orgBody, type: "store", parentId: branch.id, name: "其他门店", code: "OTHER-STORE" });
  const outside = await camera.save(admin.auth, { ...input, name: "范围外设备", rtspPath: "/other", organizationId: otherStore.id });
  const foreignRoot = await workspace.saveOrganization(other.auth, { ...orgBody, type: "company", parentId: null, name: "其他企业根" });
  assert.equal((await request(admin, "PUT", `/camera-workspace/organizations/${group.id}`, { ...orgBody, parentId: foreignRoot.id })).status, 400);
  const movableA = await workspace.saveOrganization(admin.auth, { ...orgBody, name: "并发节点 A" });
  const movableB = await workspace.saveOrganization(admin.auth, { ...orgBody, name: "并发节点 B" });
  const moved = await Promise.all([
    request(admin, "PUT", `/camera-workspace/organizations/${movableA.id}`, { ...orgBody, parentId: movableB.id }),
    request(admin, "PUT", `/camera-workspace/organizations/${movableB.id}`, { ...orgBody, parentId: movableA.id }),
  ]);
  assert.deepEqual(moved.map((response) => response.status).sort(), [200, 400]);
  pass("独立公司→组织→门店 CRUD、叶子/引用/跨租户限制与并发移动防循环");

  const username = `camera-test-${crypto.randomUUID()}`;
  const password = crypto.randomBytes(20).toString("hex");
  const membership = { organizationId: group.id, includeDescendants: true, isActive: true, remark: "工作区测试" };
  const created = await request(admin, "POST", "/camera-workspace/members", { ...membership, account: { username, password, name: "视频范围测试成员" } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const user = await new Parse.Query(Parse.User).get(created.body.data.user_id, master); fixtures.push(user);
  const session = createSession(user.id);
  const videoMember = { cookie: `${config.auth.cookieName}=${session.token}`, csrf: session.csrfToken, token: session.token, user, auth: await getAuthContext(user.id) };
  const logged = await request(null, "POST", "/auth/login", { username, password });
  assert.equal(logged.status, 200);
  assert.equal(videoMember.auth.isAdmin, false);
  assert.equal((await request(videoMember, "GET", "/camera-workspace/members/options")).status, 403);
  assert.equal((await request(videoMember, "POST", "/camera-workspace/members", { ...membership, userId: other.user.id })).status, 403);
  assert.equal((await request(admin, "POST", "/camera-workspace/members", { ...membership, userId: other.user.id })).status, 400);
  const allowed = await request(videoMember, "GET", "/cameras");
  assert.deepEqual(allowed.body.data.devices.map((row) => row.id), [id]);
  assert.equal((await request(videoMember, "GET", `/cameras/${outside.id}/recordings`)).status, 404);
  assert.equal((await request(videoMember, "GET", `/cameras/${id}`)).status, 403);
  pass("创建可登录的视频专用账号、关联成员、最小岗位和下级门店视频范围");

  const saved = await request(videoMember, "POST", "/camera-workspace/views", { name: "门店值守", screens: 16, devices: [id] });
  assert.equal(saved.status, 200);
  assert.equal((await request(other, "GET", "/camera-workspace/views")).body.data.length, 0);
  assert.equal((await request(videoMember, "POST", "/camera-workspace/views", { name: "越界", screens: 17, devices: [] })).status, 400);
  assert.equal((await request(videoMember, "POST", "/camera-workspace/views", { name: "越界设备", screens: 1, devices: [outside.id] })).status, 404);
  const memberId = created.body.data.id;
  await workspace.saveMember(admin.auth, { ...membership, userId: user.id, organizationId: otherStore.id }, memberId);
  assert.deepEqual((await request(videoMember, "GET", "/camera-workspace/views")).body.data[0].devices, [null]);
  await workspace.saveMember(admin.auth, { ...membership, userId: user.id }, memberId);
  await workspace.saveOrganization(admin.auth, { ...orgBody, name: group.name, code: group.code, isActive: false }, group.id);
  assert.equal((await request(videoMember, "GET", "/cameras")).body.data.devices.length, 0);
  await workspace.saveOrganization(admin.auth, { ...orgBody, name: group.name, code: group.code }, group.id);
  const assigned = await request(admin, "POST", "/camera-workspace/devices/assign", { deviceIds: [outside.id], organizationId: store.id });
  assert.equal(assigned.status, 200);
  assert.equal((await request(videoMember, "GET", "/cameras")).body.data.devices.length, 2);
  const denied = await request(admin, "POST", "/camera-workspace/devices/assign", { deviceIds: [outside.id, crypto.randomUUID()], organizationId: branch.id });
  assert.equal(denied.status, 404);
  assert.equal((await camera.get(admin.auth, outside.id)).organization_id, store.id);
  assert.equal((await request(admin, "POST", "/camera-workspace/devices/assign", { deviceIds: [id], organizationId: foreignRoot.id })).status, 404);
  pass("个人16屏视图隔离、权限变更裁剪、停用父组织与原子批量归属");
  assert.equal((await request(admin, "DELETE", `/camera-workspace/members/${memberId}`)).status, 200);
  assert.ok(await new Parse.Query(Parse.User).get(user.id, master));
  assert.equal((await request(videoMember, "GET", "/cameras")).body.data.devices.length, 0);
  const readded = await workspace.saveMember(admin.auth, { ...membership, userId: user.id });
  const search = await request(admin, "GET", `/cameras?keyword=${encodeURIComponent("范围外")}&organizationId=${store.id}`);
  assert.deepEqual(search.body.data.devices.map((row) => row.id), [outside.id]);
  const history = await request(admin, "GET", "/camera-workspace/activity");
  assert.ok(history.body.data.some((row) => row.action === "device.assign"));
  assert.ok(!JSON.stringify(history.body).includes(password));
  await workspace.removeOrganization(admin.auth, otherStore.id);
  pass("成员移除保留平台账号、重新关联、设备组织/关键词查询和脱敏审计");
  context.videoMember = videoMember;
  context.videoMembership = readded;
  context.outsideId = outside.id;
}

/**
 * 通过本机 MediaMTX + FFmpeg 测试源验证真实转码、HLS 鉴权、停止清理和自动本地录像。
 * @param {object} context 必填，apiChecks 创建的隔离成员/设备。
 * @returns {Promise<void>} 可选媒体工具不存在时明确跳过；不接触真实摄像头。
 */
async function mediaChecks(context) {
  const executable = process.env.CAMERA_TEST_MEDIAMTX || path.resolve("resources/tools/mediamtx/mediamtx.exe");
  try { await fs.access(executable); await media.requireFfmpeg(); }
  catch { process.stdout.write("SKIP 真实视频链路：请安装 FFmpeg 和 CAMERA_TEST_MEDIAMTX 后重跑\n"); return; }
  const reserve = net.createServer();
  const port = await listen(reserve, host);
  await new Promise((resolve) => reserve.close(resolve));
  const configuration = path.join(temporary, "mediamtx.yml");
  await fs.writeFile(configuration, `logLevel: error\nrtspAddress: ${host}:${port}\nrtspTransports: [tcp]\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\npaths:\n  all_others:\n`);
  const server = spawn(executable, [configuration], { cwd: temporary, windowsHide: true, stdio: "ignore" });
  children.push(server);
  context.media = { port };
  await delay(500);
  const publisher = spawn(config.camera.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "20", "-t", "35", "-f", "rtsp", "-rtsp_transport", "tcp", `rtsp://${host}:${port}/mock`], { windowsHide: true, stdio: "ignore" });
  children.push(publisher);
  await delay(1000);
  await camera.save(context.admin.auth, { ...context.input, rtspPort: port, rtspPath: "/mock", recordingEnabled: true }, context.id);
  const abandoned = path.join(temporary, "recordings", context.id, `${Date.now()}-${crypto.randomUUID()}.partial.mp4`);
  await fs.writeFile(abandoned, "unfinished");
  const staleStream = path.join(temporary, "streams", crypto.randomUUID());
  await fs.mkdir(staleStream, { recursive: true });
  await fs.writeFile(path.join(staleStream, "index.m3u8"), "#EXTM3U");
  const oldTime = new Date(Date.now() - 120000);
  await fs.utimes(staleStream, oldTime, oldTime);
  const oldRecord = (await media.listRecordings(context.admin.auth, context.id)).files[0];
  const expired = new Date(Date.now() - 8 * 86400000);
  await fs.utimes(path.join(temporary, "recordings", context.id, oldRecord.name), expired, expired);
  media.startWorker();
  const stream = await request(context.admin, "POST", `/cameras/${context.id}/streams`, { mode: "live" });
  assert.equal(stream.status, 201, JSON.stringify(stream.body));
  const playlist = stream.body.data.url.replace("/api", "");
  assert.equal((await request(context.admin, "GET", playlist)).status, 200);
  assert.equal((await request(context.viewer, "GET", playlist)).status, 404);
  assert.equal((await request(context.other, "GET", playlist)).status, 404);
  assert.equal((await request(null, "GET", playlist)).status, 401);
  const manifest = (await request(context.admin, "GET", playlist)).bytes.toString();
  assert.ok(manifest.includes("#EXTM3U"));
  const segment = manifest.split("\n").find((line) => /^\d{6}\.ts$/.test(line));
  const segmentResponse = await request(context.admin, "GET", playlist.replace("index.m3u8", segment));
  assert.equal(segmentResponse.status, 200);
  assert.ok(segmentResponse.bytes.length > 188);
  await assert.rejects(fs.access(abandoned));
  await assert.rejects(fs.access(staleStream));
  await assert.rejects(fs.access(path.join(temporary, "recordings", context.id, oldRecord.name)));
  pass("异常退出遗留段、闲置流目录和到期完整录像自动回收");
  pass("真实 RTSP → FFmpeg → H.264 HLS 清单和片段，用户/租户/匿名隔离");
  assert.equal((await request(context.admin, "DELETE", playlist.replace("/index.m3u8", ""))).status, 200);
  assert.equal((await request(context.admin, "GET", playlist)).status, 404);
  pass("关闭播放器释放转码任务并撤销流访问");
  // 模拟设备录像服务器把 clock 请求转发到测试图案源；时间范围精度由上方 RTSP 桥测试另行断言。
  let replayClock;
  const relay = net.createServer((client) => {
    const remote = net.connect(port, host);
    const close = () => { client.destroy(); remote.destroy(); };
    client.on("error", close);
    remote.on("error", close);
    client.on("close", close);
    remote.on("close", close);
    client.on("data", replay.frameReader((frame, binary) => {
      if (binary) { remote.write(frame); return; }
      let message = frame.toString().replaceAll(`${host}:${relay.address().port}`, `${host}:${port}`);
      if (message.startsWith("PLAY ")) replayClock = message.match(/Range: clock=([^\r\n]+)/)?.[1];
      message = message.replace(/\r\n(?:Require|Rate-Control|Range):[^\r\n]*/gi, "");
      remote.write(replay.encodeMessage(message));
    }));
    remote.on("data", replay.frameReader((frame, binary) => client.write(binary ? frame : replay.encodeMessage(frame.toString().replaceAll(`${host}:${port}`, `${host}:${relay.address().port}`)))));
  });
  const relayPort = await listen(relay, host);
  let soapCount = 0;
  const soapServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      soapCount += 1;
      const body = Buffer.concat(chunks).toString();
      assert.ok(body.includes("PasswordDigest"));
      if (!req.headers.authorization) { res.writeHead(401, { "WWW-Authenticate": 'Digest realm="mock", nonce="test-nonce", qop="auth"' }); res.end(); return; }
      assert.ok(req.headers.authorization.startsWith("Digest "));
      let response;
      const endpoint = `http://${host}:${soapServer.address().port}/onvif`;
      if (body.includes("GetCapabilities")) response = `<GetCapabilitiesResponse><Capabilities><Media><XAddr>${endpoint}</XAddr></Media><Extension><Recording><XAddr>${endpoint}</XAddr></Recording><Replay><XAddr>${endpoint}</XAddr></Replay></Extension></Capabilities></GetCapabilitiesResponse>`;
      else if (body.includes("GetProfiles")) response = '<GetProfilesResponse><Profiles token="profile-1"><Name>模拟主码流</Name></Profiles></GetProfilesResponse>';
      else if (body.includes("GetStreamUri")) response = `<GetStreamUriResponse><MediaUri><Uri>rtsp://${host}:${port}/mock?stream=1&amp;subtype=0</Uri></MediaUri></GetStreamUriResponse>`;
      else if (body.includes("GetRecordings")) response = '<GetRecordingsResponse><RecordingItem><RecordingToken>00001</RecordingToken><Configuration><Content>模拟录像</Content></Configuration></RecordingItem></GetRecordingsResponse>';
      else if (body.includes("GetReplayUri")) response = `<GetReplayUriResponse><Uri>rtsp://${host}:${relayPort}/mock</Uri></GetReplayUriResponse>`;
      else { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/soap+xml" });
      res.end(`<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${response}</s:Body></s:Envelope>`);
    });
  });
  const soapPort = await listen(soapServer, host);
  await camera.save(context.admin.auth, { ...context.input, onvifPort: soapPort, rtspPort: port, rtspPath: "/mock", recordingEnabled: true }, context.id);
  const profiles = await request(context.admin, "POST", `/cameras/${context.id}/probe`);
  assert.equal(profiles.status, 200);
  assert.equal(profiles.body.data.streams[0].path, "/mock?stream=1&subtype=0");
  const deviceRecords = await request(context.admin, "POST", `/cameras/${context.id}/device-recordings`);
  assert.equal(deviceRecords.status, 200);
  assert.equal(deviceRecords.body.data.recordings[0].token, "00001");
  pass("ONVIF WS-Security + HTTP Digest 媒体配置与 Profile G 录像 token 查询");
  const deviceStream = await request(context.admin, "POST", `/cameras/${context.id}/streams`, { mode: "device", recordingToken: "00001", start: new Date(Date.now() - 600000).toISOString(), end: new Date(Date.now() - 300000).toISOString() });
  assert.equal(deviceStream.status, 201, JSON.stringify(deviceStream.body));
  assert.ok(replayClock);
  assert.ok(soapCount >= 10);
  assert.equal((await request(context.admin, "GET", deviceStream.body.data.url.replace("/api", ""))).status, 200);
  await request(context.admin, "DELETE", `/cameras/${context.id}/streams/${deviceStream.body.data.id}`);
  pass("Profile G GetReplayUri → 本地 RTSP 回放桥 → HLS 全链路");
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const files = (await media.listRecordings(context.admin.auth, context.id)).files.filter((file) => file.size > 1024);
    if (files.length) { pass("持续录像守护任务产出完整 MP4 并列入回放列表"); return; }
    await delay(1000);
  }
  assert.fail("自动录像未生成完整 MP4");
}

/**
 * 入口：使用独立测试租户，执行完释放服务、进程、测试数据和临时目录。
 * @returns {Promise<void>} 失败设置退出码，清理只作用于本轮创建的对象。
 */
async function main() {
  try {
    assert.ok(host, "需要一个私网 IPv4 测试网卡");
    await fs.mkdir(temporary, { recursive: true });
    if (process.env.CAMERA_TEST_BROWSER === "1") await fs.access(path.resolve("../vue_admin/dist/index.html"));
    await unitChecks();
    const context = await apiChecks();
    await workspaceChecks(context);
    await mediaChecks(context);
    if (process.env.CAMERA_TEST_BROWSER === "1") {
      const { chromium } = require("playwright");
      browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: process.env.CAMERA_TEST_BROWSER_CHANNEL || "msedge" } : {}) });
      const browserContext = await browser.newContext();
      const page = await browserContext.newPage();
      const frontend = base;
      await browserContext.addCookies([{ name: config.auth.cookieName, value: context.admin.token, url: frontend, httpOnly: true, sameSite: "Strict" }]);
      await page.goto(`${frontend}/system/camera`);
      await page.getByRole("heading", { name: "设备管理", exact: true }).waitFor();
      const cameraCard = page.locator(".camera-page__card").filter({ has: page.getByRole("heading", { name: context.input.name, exact: true }) });
      await cameraCard.getByRole("button", { name: "配置", exact: true }).click();
      await page.getByRole("dialog", { name: "配置摄像头" }).waitFor();
      assert.equal(await page.getByPlaceholder("留空保留原密码").inputValue(), "");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("dialog", { name: "配置摄像头", exact: true }).waitFor({ state: "hidden" });
      await cameraCard.getByRole("button", { name: "录像回放", exact: true }).click();
      await page.getByRole("button", { name: "播放", exact: true }).first().click();
      await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.videoWidth > 0 && video.readyState >= 2; });
      const playerDialog = page.locator(".el-dialog:visible").filter({ has: page.locator("video") });
      await playerDialog.locator(".el-dialog__headerbtn").click();
      await playerDialog.waitFor({ state: "hidden" });
      const historyDialog = page.locator(".el-dialog:visible").filter({ has: page.getByRole("tab", { name: "服务器本地录像" }) });
      await historyDialog.locator(".el-dialog__headerbtn").click();
      await historyDialog.waitFor({ state: "hidden" });
      pass("真实浏览器解码服务器生成的 H.264 MP4 录像");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => [...document.querySelectorAll(".el-overlay")].every((element) => getComputedStyle(element).display === "none"));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2));
      await page.screenshot({ path: path.resolve("../docs/camera-mobile-test.png"), fullPage: true });
      pass("真实浏览器菜单装配、编辑密码不回显和 390px 窄屏无横向溢出");
      await require("./camera-workspace-browser").workspaceBrowserChecks(context, page, { camera, workspace, media, spawn, config, children, pass, delay });
    }
    process.stdout.write(`摄像头回归通过：${passed} 组\n`);
  } catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
  finally {
    await browser?.close();
    await media.close();
    for (const child of children) child.kill("SIGKILL");
    for (const server of servers) server.close();
    for (const company of [companyA, companyB].filter(Boolean)) {
      await db.query("DELETE FROM camera.devices WHERE company_id=$1", [company.id]);
      await db.query("DELETE FROM camera.members WHERE company_id=$1", [company.id]);
      await db.query("DELETE FROM camera.views WHERE company_id=$1", [company.id]);
      await db.query("DELETE FROM camera.audit WHERE company_id=$1", [company.id]);
      // 同一 DELETE 会统一校验自引用外键，移除本轮隔离企业的整棵树。
      await db.query("DELETE FROM camera.organizations WHERE company_id=$1", [company.id]);
    }
    const users = fixtures.filter((item) => item.className === "_User").map((item) => pointer("_User", item.id));
    if (users.length) { const sessions = new Parse.Query("AdminSession"); sessions.containedIn("user", users); await Parse.Object.destroyAll(await sessions.find(master), master); }
    // 浏览器菜单修复会为隔离公司新增 Module/Schema，按本轮实际创建的 Company 精确清理，不能留下孤儿元数据。
    const metadataClasses = ["Schema", "Module", "Route", "Role", "AllotPermission", "Organization", "LoginActivity", "AdminSession"];
    for (const company of [companyA, companyB].filter(Boolean)) {
      for (const className of metadataClasses) {
        const query = new Parse.Query(className);
        query.equalTo("company", pointer("Company", company.id));
        query.limit(1000);
        await Parse.Object.destroyAll(await query.find(master), master);
      }
    }
    for (const object of fixtures.reverse()) if (!metadataClasses.includes(object.className)) await object.destroy(master);
    await db.pool.end();
    if (!temporary.startsWith(`${path.resolve(os.tmpdir())}${path.sep}shumian-camera-test-`)) throw new Error("拒绝清理非测试目录");
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main();
