"use strict";

// 创建独立 PostgreSQL 集群并运行真实 HTTP/浏览器回归；从不复用现有 .env、数据目录或管理员。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const servers = [];
let temporary;
let clusterStarted = false;
let parseServer;
let browser;

/** @param {string} name 必填，PostgreSQL 工具名称。 @returns {string} 环境指定目录或 PATH 中的可执行文件。 */
function pgTool(name) { return path.join(process.env.ADMIN_TEST_PG_BIN || "", name + (process.platform === "win32" ? ".exe" : "")); }

/**
 * 执行隔离进程；不输出子进程可能携带的连接配置或初始化账号。
 * @param {string} command 必填，可执行文件。
 * @param {string[]} args 必填，独立参数数组，不经 shell 拼接。
 * @param {string} label 必填，安全的步骤名称。
 * @returns {Promise<string>} 标准输出；启动或退出失败时仅抛出步骤名和退出码。
 */
function run(command, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`RUN ${label}`);
    // pg_ctl 在 Windows 上可能让 PostgreSQL 继承管道句柄；忽略 stdio 避免等待后台服务退出才收到 close。
    const capture = command === process.execPath;
    const child = spawn(command, args, { cwd: root, env: process.env, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore" });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", () => reject(new Error(`${label} 无法启动，请检查工具路径。`)));
    child.once("close", (code) => {
      if (code === 0) return resolve(output);
      for (const key of ["DATABASE_URI", "PARSE_APP_ID", "PARSE_MASTER_KEY", "AUTH_JWT_SECRET", "INITIAL_ADMIN_USERNAME", "INITIAL_ADMIN_PASSWORD"]) {
        if (process.env[key]) output = output.split(process.env[key]).join("[已脱敏]");
      }
      reject(new Error(`${label} 失败，退出码 ${code}。\n${output.slice(-4000)}`));
    });
  });
}

/** @returns {Promise<number>} 操作系统分配的空闲回环端口；无长期监听副作用。 */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** @param {http.Server} server 必填，测试 HTTP 服务。 @param {number} port 必填，空闲端口。 @returns {Promise<void>} 仅监听回环并登记清理。 */
async function listen(server, port) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}

/**
 * 发起真实 BFF 请求，不伪造认证上下文；会话 Cookie 和 CSRF 仅在内存中保存。
 * @param {object} client 必填，包含 cookie/csrf 的测试客户端，允许空对象。
 * @param {string} target 必填，/api 开头的路径。
 * @param {{method?: string, body?: object, form?: FormData, csrf?: boolean, origin?: string}} [options] 可选，HTTP 参数。
 * @returns {Promise<{status: number, data: any, response: Response}>} 响应及业务数据；网络错误继续抛出。
 */
async function api(client, target, options = {}) {
  const method = options.method || "GET";
  const headers = { Origin: options.origin || process.env.PUBLIC_ORIGIN };
  if (client.cookie) headers.Cookie = client.cookie;
  if (client.csrf && options.csrf !== false) headers["X-CSRF-Token"] = client.csrf;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${process.env.PORT}${target}`, {
    method, headers, body: options.form || (options.body ? JSON.stringify(options.body) : undefined),
  });
  const cookie = response.headers.getSetCookie?.().filter((value) => value.startsWith(`${process.env.AUTH_COOKIE_NAME}=`)).at(-1);
  if (cookie) client.cookie = cookie.split(";", 1)[0];
  const json = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  return { status: response.status, data: json?.data, response };
}

/** @param {string} username 必填，随机测试账号。 @param {string} password 必填，随机测试密码。 @returns {Promise<object>} 真实登录的内存会话；不输出凭据。 */
async function login(username, password) {
  const client = {};
  const result = await api(client, "/api/auth/login", { method: "POST", body: { username, password } });
  assert.equal(result.status, 200, "隔离账号应能登录");
  client.csrf = result.data.csrfToken;
  assert.match(result.response.headers.get("set-cookie"), /HttpOnly/i);
  return client;
}

/** @returns {Promise<void>} 执行持久化、安全边界及真实 SPA 验证，finally 回收全部测试服务和临时集群。 */
async function main() {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "shumian-integration-"));
  const databasePort = await freePort();
  const internalPort = await freePort();
  const publicPort = await freePort();
  const frontendPort = await freePort();
  await fs.writeFile(path.join(temporary, "empty.env"), "", "utf8");
  Object.assign(process.env, {
    ENV_FILE: path.join(temporary, "empty.env"), DOTENV_CONFIG_QUIET: "true", NODE_ENV: "development",
    DATABASE_URI: `postgres://qa_owner@127.0.0.1:${databasePort}/qa_admin`, COLLAB_DATABASE_URI: "",
    PARSE_APP_ID: crypto.randomUUID(), PARSE_MASTER_KEY: crypto.randomBytes(32).toString("hex"),
    AUTH_JWT_SECRET: crypto.randomBytes(32).toString("hex"), AUTH_COOKIE_NAME: "isolated_admin_session",
    PARSE_INTERNAL_HOST: "127.0.0.1", PARSE_INTERNAL_PORT: String(internalPort),
    PARSE_INTERNAL_URL: `http://127.0.0.1:${internalPort}/parse`, PORT: String(publicPort),
    PUBLIC_ORIGIN: `http://127.0.0.1:${frontendPort}`, CORS_ORIGINS: `http://127.0.0.1:${frontendPort}`,
    COLLAB_ALLOWED_ORIGINS: `http://127.0.0.1:${frontendPort}`, OFFICE_DOCUMENT_SERVER_URL: "", OFFICE_INTERNAL_URL: "", OFFICE_JWT_SECRET: "",
    UPLOAD_STORAGE_DIR: path.join(temporary, "uploads"), COLLAB_STORAGE_DIR: path.join(temporary, "collab"),
    CAMERA_STORAGE_DIR: path.join(temporary, "camera"), CAMERA_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    INITIAL_ADMIN_USERNAME: `qa-${crypto.randomUUID()}`, INITIAL_ADMIN_PASSWORD: crypto.randomBytes(24).toString("hex"),
  });
  try {
    const dataDirectory = path.join(temporary, "pgdata");
    await run(pgTool("initdb"), ["-D", dataDirectory, "-U", "qa_owner", "-A", "trust", "--no-locale", "-E", "UTF8"], "创建临时数据库集群");
    await run(pgTool("pg_ctl"), ["-D", dataDirectory, "-l", path.join(temporary, "postgres.log"), "-w", "-t", "30", "-o", `-h 127.0.0.1 -p ${databasePort} -F`, "start"], "启动临时数据库");
    clusterStarted = true;
    await run(pgTool("createdb"), ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "qa_owner", "qa_admin"], "创建测试库");
    const express = require("express");
    const logger = require("../lib/logger");
    logger.info = logger.warn = logger.error = () => {};
    parseServer = require("../services/parse-runtime").createParseServer();
    await parseServer.start();
    const internal = express();
    internal.use("/parse", parseServer.app);
    parseServer.server = http.createServer(internal);
    await listen(parseServer.server, internalPort);
    await run(process.execPath, ["scripts/seed-initial-data.js"], "隔离数据初始化");
    await run(process.execPath, ["scripts/migrate-collab.js"], "隔离协同迁移");
    await run(process.execPath, ["scripts/migrate-camera.js"], "隔离视频迁移");
    await listen(http.createServer(require("../app-factory").createPublicApp()), publicPort);
    console.log("PASS 独立 PostgreSQL/Parse/BFF 启动与首次初始化，现有环境未改动");

    const admin = await login(process.env.INITIAL_ADMIN_USERNAME, process.env.INITIAL_ADMIN_PASSWORD);
    assert.equal((await api(admin, "/api/auth/session")).status, 200);
    assert.equal((await api({}, "/api/data/query", { method: "POST", body: { className: "Module" } })).status, 401);
    assert.equal((await api(admin, "/api/data/query", { method: "POST", body: { className: "Module" }, csrf: false })).status, 403);
    assert.equal((await api(admin, "/api/auth/session", { origin: "https://untrusted.invalid" })).status, 403);
    console.log("PASS 真实登录/会话恢复、匿名拒绝、CSRF 与来源白名单");

    const className = "PublishRegression";
    assert.equal((await api(admin, "/api/schema", { method: "POST", body: { className, fields: [
      { name: "name", type: "String" }, { name: "at", type: "Date" }, { name: "active", type: "Boolean" },
    ] } })).status, 201);
    const row = await api(admin, `/api/data/${className}`, { method: "POST", body: { attributes: {
      name: "持久化测试", at: { __type: "Date", iso: "2026-11-01T12:00:00.000Z" }, active: false,
    } } });
    assert.equal(row.status, 201);
    const id = row.data.objectId;
    const query = { className, filters: [{ field: "at", operator: "greaterThanOrEqualTo", value: { __type: "Date", iso: "2026-11-01T00:00:00.000Z" } }] };
    const listed = await api(admin, "/api/data/query", { method: "POST", body: query });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.count, 1);
    assert.equal(listed.data.data[0].active, false);
    assert.equal((await api(admin, `/api/data/${className}/${id}`, { method: "PUT", body: { attributes: { name: "已修改" } } })).status, 200);
    console.log("PASS 真实 Schema 创建、普通记录新增、Date/false 持久化、区间查询与修改");

    const Parse = require("parse/node");
    const master = { useMasterKey: true };
    const company = await new Parse.Object("Company").save({ name: "隔离企业 B" }, master);
    const username = `other-${crypto.randomUUID()}`;
    const password = crypto.randomBytes(24).toString("hex");
    const user = await new Parse.User().signUp({ username, password, company }, master);
    await company.save({ admin: [user] }, master);
    const other = await login(username, password);
    const foreignQuery = await api(other, "/api/data/query", { method: "POST", body: query });
    assert.equal(foreignQuery.status, 200);
    assert.equal(foreignQuery.data.count, 0);
    assert.equal((await api(other, `/api/data/${className}/${id}`, { method: "PUT", body: { attributes: { name: "越权" } } })).status, 404);
    assert.equal((await api(other, `/api/data/${className}/${id}`, { method: "DELETE" })).status, 404);
    console.log("PASS 第二真实租户无法查询、修改或删除首租户记录");

    const rejectedFile = new FormData();
    rejectedFile.set("file", new Blob(["<script>fixture</script>"], { type: "text/html" }), "fixture.html");
    assert.equal((await api(admin, "/api/files", { method: "POST", form: rejectedFile })).status, 400);
    const acceptedFile = new FormData();
    acceptedFile.set("file", new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=", "base64")], { type: "image/png" }), "fixture.png");
    const uploaded = await api(admin, "/api/files", { method: "POST", form: acceptedFile });
    assert.equal(uploaded.status, 201);
    assert.equal((await api(admin, uploaded.data.url)).status, 200);
    assert.equal((await api(other, uploaded.data.url)).status, 404);
    assert.equal((await api(admin, `/api/data/${className}/${id}`, { method: "DELETE" })).status, 204);
    assert.equal((await api(admin, "/api/data/query", { method: "POST", body: query })).data.count, 0);
    console.log("PASS 文件白名单、真实上传下载、跨租户拒绝及删除持久化");

    if (process.env.ADMIN_TEST_FULL_DOMAIN === "1") {
      const collabResult = await run(process.execPath, ["scripts/collab-three-cycle-test.js"], "隔离协同三轮回归");
      assert.match(collabResult, /COLLAB_THREE_CYCLE_PASS/);
      console.log(collabResult.match(/COLLAB_THREE_CYCLE_PASS[^\r\n]*/)[0]);
      process.env.CAMERA_TEST_BROWSER = "0";
      process.env.CAMERA_TEST_MEDIAMTX = path.join(temporary, "not-installed.exe");
      const cameraResult = await run(process.execPath, ["scripts/camera-test.js"], "隔离摄像头接口回归");
      assert.match(cameraResult, /摄像头回归通过/);
      console.log(cameraResult.match(/摄像头回归通过[^\r\n]*/)[0]);
    }

    const frontend = express();
    // 转发原始请求流；保持 SPA 与 BFF 同源，不替换任何业务响应。
    frontend.use("/api", (req, res) => {
      const upstream = http.request({ hostname: "127.0.0.1", port: publicPort, path: req.originalUrl, method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on("error", () => { res.status(502).end(); });
      req.pipe(upstream);
    });
    const dist = path.resolve(root, "../vue_admin/dist");
    frontend.use(express.static(dist));
    frontend.use((req, res) => res.sendFile(path.join(dist, "index.html")));
    await listen(http.createServer(frontend), frontendPort);
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true, channel: process.env.ADMIN_UI_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${process.env.PUBLIC_ORIGIN}/login`);
    await page.getByLabel("账号").fill(process.env.INITIAL_ADMIN_USERNAME);
    await page.getByLabel("密码").fill(process.env.INITIAL_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(/\/home$/);
    for (const target of ["system/module", "system/table", "system/organization", "system/member", "system/position", "system/online-member", "camera/organizations", "camera/devices", "camera/members", "camera/video", "collab/spreadsheet"]) {
      await page.goto(`${process.env.PUBLIC_ORIGIN}/${target}`);
      await page.waitForFunction(() => !document.querySelector(".page-loading__indicator"));
      await page.locator("h1").waitFor();
      assert(!await page.getByText("页面运行异常", { exact: true }).count(), `${target} 无运行异常`);
    }
    assert.deepEqual(errors, []);
    console.log("PASS 真实浏览器登录、动态路由装配与 11 个系统/视频/协同页面加载，无 API 模拟");
    const originalCookie = admin.cookie;
    await api(admin, "/api/auth/logout", { method: "POST" });
    assert.equal((await api(admin, "/api/auth/session")).status, 401);
    assert.equal((await api({ cookie: originalCookie }, "/api/auth/session")).status, 401);
    assert.equal((await page.request.get(`${process.env.PUBLIC_ORIGIN}/api/auth/session`)).status(), 200);
    console.log("PASS 真实退出撤销会话，后续请求被拒绝");
  } finally {
    try {
      await browser?.close();
      for (const server of servers.reverse()) {
        if (server === parseServer?.server) continue;
        await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      }
      if (parseServer) {
        await require("../services/camera-db.service").pool.end();
        await require("../services/collab-database.service").closeCollabPool();
        await parseServer.handleShutdown();
      }
    } finally {
      if (clusterStarted) await run(pgTool("pg_ctl"), ["-D", path.join(temporary, "pgdata"), "-m", "fast", "-w", "stop"], "停止临时数据库");
      const resolved = path.resolve(temporary);
      if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}shumian-integration-`)) throw new Error("拒绝清理非隔离目录");
      await fs.rm(resolved, { recursive: true, force: true });
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
