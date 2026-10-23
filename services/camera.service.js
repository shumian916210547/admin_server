"use strict";

const crypto = require("crypto");
const { config } = require("../config/env");
const { badRequest, notFound, HttpError } = require("../lib/http-error");
const db = require("./camera-db.service");
const network = require("./camera-network.service");
const access = require("./camera-access.service");
const { audit } = require("./camera-workspace.service");

/** 浏览器可见字段明确白名单，排除密码密文、封面二进制和内部路径。 */
const publicColumns = "id, name, brand, host(host) AS host, onvif_port, rtsp_port, rtsp_path, location, recording_enabled, (cover IS NOT NULL) AS has_cover, updated_at, organization_id, (SELECT o.name FROM camera.organizations o WHERE o.id=camera.devices.organization_id AND o.company_id=camera.devices.company_id) AS organization_name";
/** 内置品牌仅提供本地路径建议，不能据此推断某型号一定支持协议。 */
const brands = ["generic", "hikvision", "dahua", "ezviz", "xiaomi"];

/**
 * 校验页面操作权限，复用真实 Route、Role 和 AllotPermission；不信任客户端公司标识。
 * @param {object} auth 必填，authenticate 产生的可信会话。
 * @param {string} [action="query"] 可选，query/insert/edit/remove 等现有操作名。
 * @returns {Promise<void>} 授权通过时兑现；无数据写入。
 * @throws {HttpError} 没有租户或页面操作权限时 403。
 */
async function authorize(auth, action = "query") {
  if (!auth?.companyId) throw new HttpError(403, "CAMERA_TENANT", "缺少有效的企业会话");
  if (action === "query") await access.authorizeRead(auth, ["CameraDevice", "CameraVideo"]);
  else await access.authorize(auth, "CameraDevice", action);
}

/**
 * 读取独立的设备凭据加密密钥，不自动复用 JWT 或 Parse 密钥。
 * @returns {Buffer} 32 字节 AES-256 密钥。
 * @throws {HttpError} 缺少合法 Base64 密钥时 503。
 */
function encryptionKey() {
  const key = Buffer.from(config.camera.encryptionKey, "base64");
  if (key.length !== 32) throw new HttpError(503, "CAMERA_KEY", "请先配置 CAMERA_ENCRYPTION_KEY（32 字节随机密钥的 Base64）");
  return key;
}

/**
 * 使用随机 IV 的 AES-256-GCM 加密设备账号密码。
 * @param {{username:string,password:string}} value 必填，仅内存中的设备凭据。
 * @returns {string} iv.tag.ciphertext Base64 密文，不包含明文。
 * @throws {HttpError} 密钥未配置时 503。
 */
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
}

/**
 * 解密保存的设备凭据，仅供服务端设备通信，不返回浏览器。
 * @param {string} value 必填，AES-GCM 密文。
 * @returns {{username:string,password:string}} 设备账号密码。
 * @throws {HttpError} 密钥变更或密文损坏时 503。
 */
function decrypt(value) {
  try {
    const [iv, tag, data] = value.split(".").map((part) => Buffer.from(part, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
  } catch {
    throw new HttpError(503, "CAMERA_KEY", "设备凭据无法解密，请检查加密密钥或重新填写设备凭据");
  }
}

/**
 * 校验 URL 中的内部 UUID，避免任意文件路径和异常数据库类型转换。
 * @param {unknown} value 必填，摄像头/流会话 UUID 字符串。
 * @returns {string} 小写 UUID。
 * @throws {HttpError} 非 UUID 时 400。
 */
function uuid(value) {
  if (typeof value !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) throw badRequest("摄像头标识格式无效");
  return value.toLowerCase();
}

/**
 * 校验有限长度文本，禁止控制字符，防止将换行带入设备协议。
 * @param {unknown} value 必填，客户端字段值。
 * @param {string} label 必填，中文字段名。
 * @param {number} max 必填，最大字符数。
 * @param {boolean} [required=false] 可选，是否必须非空。
 * @returns {string} 去除首尾空白后的文本。
 * @throws {HttpError} 类型、长度或控制字符不合法时 400。
 */
function text(value, label, max, required = false) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value) || (required && !value.trim())) throw badRequest(`${label}格式无效或超过 ${max} 字符`);
  return value.trim();
}

/**
 * 校验端口整数。
 * @param {unknown} value 必填，1 至 65535 的整数。
 * @returns {number} 合法端口，无副作用。
 * @throws {HttpError} 非法端口时 400。
 */
function port(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw badRequest("摄像头端口必须为 1 至 65535 的整数");
  return value;
}

/**
 * 校验 RTSP 相对路径，禁止覆盖 host、用户信息、片段或控制字符。
 * @param {unknown} value 必填，以单个 / 开头的路径，可含查询参数。
 * @returns {string} 合法路径，不发网络请求。
 * @throws {HttpError} 路径非法时 400。
 */
function rtspPath(value) {
  const result = text(value, "RTSP 路径", 1000, true);
  if (!result.startsWith("/") || result.startsWith("//") || /[\\#\s]/.test(result) || /[\x00-\x1f\x7f]/.test(decodeURIComponentSafe(result))) throw badRequest("RTSP 路径必须以单个 / 开头，且不能含空白、片段或控制字符");
  return result;
}

/**
 * 解码 URL 路径以检测编码控制字符。
 * @param {string} value 必填，URL 路径。
 * @returns {string} 解码结果。
 * @throws {HttpError} 百分号转义无效时 400。
 */
function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { throw badRequest("RTSP 路径转义格式无效"); }
}

/**
 * 获取已授权租户内设备；凭据仍为密文，仅内部使用。
 * @param {object} auth 必填，可信会话；调用者须先做操作授权。
 * @param {string} id 必填，设备 UUID。
 * @returns {Promise<object>} 内部设备记录。
 * @throws {HttpError} 不存在或跨租户均返回 404。
 */
async function get(auth, id) {
  const result = await db.query("SELECT *, host(host) AS host FROM camera.devices WHERE id=$1 AND company_id=$2", [uuid(id), auth.companyId]);
  if (!result.rows[0]) throw notFound("摄像头不存在或不属于当前企业");
  await access.organization(auth, result.rows[0].organization_id);
  return result.rows[0];
}

/**
 * 返回当前租户的设备列表和非敏感运行参数，最多 500 个通道。
 * @param {object} auth 必填，可信会话。
 * @param {{organizationId?:string,includeDescendants?:string,keyword?:string}} [query={}] 可选，组织/含下级/关键词过滤，unassigned 仅管理员可用。
 * @returns {Promise<object>} devices 和部署状态；不会返回密码。
 * @throws {HttpError} 权限不足或迁移未完成时拒绝。
 */
async function list(auth, query = {}) {
  await authorize(auth);
  const scope = await access.scope(auth);
  const result = await db.query(`SELECT ${publicColumns} FROM camera.devices WHERE company_id=$1 ORDER BY created_at DESC LIMIT 500`, [auth.companyId]);
  let devices = result.rows.filter((row) => !scope.ids || scope.ids.includes(row.organization_id));
  if (query.organizationId === "unassigned") devices = auth.isAdmin ? devices.filter((row) => !row.organization_id) : [];
  else if (query.organizationId) {
    await access.organization(auth, query.organizationId);
    const ids = [query.organizationId];
    if (query.includeDescendants !== "false") {
      for (let index = 0; index < ids.length; index += 1) for (const row of scope.rows) if (row.parent_id === ids[index] && !ids.includes(row.id)) ids.push(row.id);
    }
    devices = devices.filter((row) => ids.includes(row.organization_id));
  }
  const keyword = access.text(query.keyword, "设备关键词", 100).toLowerCase();
  if (keyword) devices = devices.filter((row) => [row.name, row.host, row.location].some((value) => value.toLowerCase().includes(keyword)));
  const permissions = {};
  for (const action of ["insert", "edit", "remove"]) {
    try { await authorize(auth, action); permissions[action] = true; } catch (error) { if (error.status !== 403) throw error; permissions[action] = false; }
  }
  return { devices, permissions, credentialReady: Buffer.from(config.camera.encryptionKey, "base64").length === 32, retentionDays: config.camera.retentionDays, maxStorageMB: config.camera.maxStorageBytes / 1024 / 1024, maxStreams: config.camera.maxStreams, maxLiveStreams: config.camera.maxLiveStreams, canAudit: Boolean(auth.isAdmin) };
}

/**
 * 新建或完整更新摄像头基础配置；空密码保留旧凭据，不回显任何密码。
 * @param {object} auth 必填，可信会话。
 * @param {object} input 必填，name/brand/host/onvifPort/rtspPort/rtspPath/location/username/password/recordingEnabled；不接收 companyId。
 * @param {string} [id] 可选，编辑设备 UUID；缺省为新增。
 * @returns {Promise<{id:string}>} 已保存设备 ID；修改设备表。
 * @throws {HttpError} 参数、授权、密钥或重复通道错误时抛出。
 */
async function save(auth, input, id) {
  await authorize(auth, id ? "edit" : "insert");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("摄像头配置必须是对象");
  const previous = id ? await get(auth, id) : null;
  const organizationId = input.organizationId || previous?.organization_id || null;
  if (!organizationId && !previous) throw badRequest("请选择设备归属的视频组织");
  await access.organization(auth, organizationId, Boolean(organizationId));
  const name = text(input.name, "摄像头名称", 100, true);
  const host = network.validateHost(input.host);
  const brand = brands.includes(input.brand) ? input.brand : "generic";
  const path = rtspPath(input.rtspPath);
  const username = text(input.username, "设备账号", 100, true);
  if (typeof input.recordingEnabled !== "boolean") throw badRequest("录像开关必须是布尔值");
  let credentials;
  if (input.password === "" && previous) {
    const old = decrypt(previous.credentials);
    credentials = encrypt({ username, password: old.password });
  } else {
    if (typeof input.password !== "string" || !input.password || input.password.length > 200 || /[\x00-\x1f\x7f]/.test(input.password)) throw badRequest("请填写有效的设备密码（最多 200 字符）");
    credentials = encrypt({ username, password: input.password });
  }
  const deviceId = id ? uuid(id) : crypto.randomUUID();
  const values = [deviceId, auth.companyId, name, brand, host, port(input.onvifPort), port(input.rtspPort), path, credentials, text(input.location, "安装位置", 200), input.recordingEnabled, organizationId];
  await db.transaction(auth.companyId, async (client) => {
    if (previous) {
      await client.query("UPDATE camera.devices SET name=$3,brand=$4,host=$5,onvif_port=$6,rtsp_port=$7,rtsp_path=$8,credentials=$9,location=$10,recording_enabled=$11,organization_id=$12,updated_at=now() WHERE id=$1 AND company_id=$2", values);
    } else {
      const count = await client.query("SELECT count(*)::int AS count FROM camera.devices WHERE company_id=$1", [auth.companyId]);
      if (count.rows[0].count >= 500) throw badRequest("每个企业最多管理 500 个摄像头通道");
      await client.query("INSERT INTO camera.devices(id,company_id,name,brand,host,onvif_port,rtsp_port,rtsp_path,credentials,location,recording_enabled,organization_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", values);
    }
    await audit(client, auth, previous ? "device.update" : "device.create", deviceId, `${previous ? "修改" : "关联"}设备：${name}`);
  });
  return { id: deviceId, restartMedia: !previous || previous.host !== host || previous.rtsp_port !== input.rtspPort || previous.rtsp_path !== path || previous.recording_enabled !== input.recordingEnabled || Boolean(input.password) || decrypt(previous.credentials).username !== username };
}

/**
 * 获取可编辑的设备字段；仅返回账号，不返回密码。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，设备 UUID。
 * @returns {Promise<object>} 表单可用的字段。
 * @throws {HttpError} 无 edit 权限、跨租户或密钥不可用时拒绝。
 */
async function detail(auth, id) {
  await authorize(auth, "edit");
  const camera = await get(auth, id);
  return { id: camera.id, name: camera.name, brand: camera.brand, host: camera.host, onvifPort: camera.onvif_port, rtspPort: camera.rtsp_port, rtspPath: camera.rtsp_path, location: camera.location, recordingEnabled: camera.recording_enabled, organizationId: camera.organization_id, username: decrypt(camera.credentials).username, password: "" };
}

/**
 * 解除设备关联，录像文件保留到保留期自动清理；调用者应先停止该设备的媒体任务。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，设备 UUID。
 * @returns {Promise<void>} 删除设备配置（含凭据和封面）。
 * @throws {HttpError} 无 remove 权限或跨租户时拒绝。
 */
async function remove(auth, id) {
  await authorize(auth, "remove");
  const camera = await get(auth, id);
  await db.transaction(auth.companyId, async (client) => {
    await client.query("DELETE FROM camera.devices WHERE id=$1 AND company_id=$2", [id, auth.companyId]);
    await audit(client, auth, "device.remove", id, `解除设备关联：${camera.name}`);
  });
}

/**
 * 保存最多 512 KiB 的 JPEG/PNG/WebP 封面，检查文件签名，不接受 SVG 或任意 URL。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，设备 UUID。
 * @param {{data?:string,type?:string,clear?:boolean}} input 必填，Base64 图像及 MIME；clear=true 表示清除封面。
 * @returns {Promise<void>} 写入私有封面字段。
 * @throws {HttpError} 无 edit 权限或内容非法时拒绝。
 */
async function setCover(auth, id, input) {
  await authorize(auth, "edit");
  await get(auth, id);
  let data = null;
  let type = null;
  if (input?.clear !== true) {
    if (typeof input?.data !== "string" || input.data.length > 710000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw badRequest("封面必须是 512 KiB 以内的图片");
    data = Buffer.from(input.data, "base64");
    const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
    const webp = data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP";
    type = png ? "image/png" : jpeg ? "image/jpeg" : webp ? "image/webp" : null;
    if (!type || type !== input.type || data.length > 512 * 1024) throw badRequest("封面仅支持 512 KiB 以内的 JPEG、PNG 或 WebP，且内容必须与类型一致");
  }
  await db.query("UPDATE camera.devices SET cover=$3,cover_type=$4,updated_at=now() WHERE id=$1 AND company_id=$2", [id, auth.companyId, data, type]);
}

/**
 * 校验设备返回的 RTSP 地址并剥离用户信息，防止将密码回传前端。
 * @param {string} value 必填，设备返回的绝对 RTSP URI。
 * @param {string} host 必填，设备私网 IPv4。
 * @returns {{port:number,path:string}} 受控的端口和相对路径。
 * @throws {HttpError} 不同 host 或不合法协议时 400。
 */
function streamAddress(value, host) {
  let url;
  try { url = new URL(value); } catch { throw badRequest("设备没有返回有效的 RTSP 地址"); }
  if (url.protocol !== "rtsp:" || url.hostname !== host) throw badRequest("设备 RTSP 地址必须指向同一局域网 IP");
  return { port: port(Number(url.port || 554)), path: rtspPath(`${url.pathname}${url.search}`) };
}

/**
 * 探测已保存设备的 ONVIF 通道并返回脱敏路径，不自动修改配置。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，设备 UUID。
 * @returns {Promise<object>} 通道列表与 Profile G 能力标志。
 * @throws {HttpError} 授权或设备通信失败时抛出。
 */
async function probe(auth, id) {
  await authorize(auth, "edit");
  const camera = await get(auth, id);
  const info = await network.inspect(camera, decrypt(camera.credentials));
  return { streams: info.streams.map((stream) => ({ name: stream.name, ...streamAddress(stream.uri, camera.host) })), devicePlayback: Boolean(info.recording && info.replay) };
}

module.exports = { authorize, list, save, detail, get, remove, decrypt, encrypt, uuid, setCover, probe, streamAddress, rtspPath };
