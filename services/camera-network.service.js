"use strict";

const os = require("os");
const net = require("net");
const http = require("http");
const dgram = require("dgram");
const crypto = require("crypto");
const { XMLParser } = require("fast-xml-parser");
const { config } = require("../config/env");
const { badRequest, HttpError } = require("../lib/http-error");

/** 禁止实体展开，移除命名空间以兼容不同厂商的 ONVIF XML 前缀。 */
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  processEntities: false,
  parseTagValue: false,
  tagValueProcessor: decodeXml,
  attributeValueProcessor: decodeXml,
});
const namespaces = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trc="http://www.onvif.org/ver10/recording/wsdl" xmlns:trp="http://www.onvif.org/ver10/replay/wsdl"';

/**
 * 仅解码 XML 预定义与数字字符实体，保持自定义/外部实体关闭；保留 token 的前导零。
 * @param {string} name 必填，解析器传入的标签或属性名，当前不参与转换。
 * @param {string} value 必填，XML 文本或属性值。
 * @returns {string} 单次实体解码后的文本，不进行递归展开或外部资源访问。
 */
function decodeXml(name, value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, code) => {
    const predefined = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, code)) return predefined[code];
    const point = code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}

/**
 * 将 IPv4 转成无符号整数，用于网段匹配。
 * @param {string} address 必填，点分十进制 IPv4。
 * @returns {number} 32 位整数；调用者先校验 IPv4。
 */
function ipNumber(address) {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

/**
 * 判断地址是否属于 CIDR，拒绝不合法的管理员配置。
 * @param {string} address 必填，合法 IPv4。
 * @param {string} cidr 必填，IPv4/前缀长度，允许 0 至 32。
 * @returns {boolean} 网段匹配结果；无网络副作用。
 * @throws {HttpError} CIDR 格式错误时 400。
 */
function inCidr(address, cidr) {
  const [base, prefix] = cidr.split("/");
  if (net.isIP(base) !== 4 || !/^\d+$/.test(prefix || "") || Number(prefix) > 32) throw badRequest("CAMERA_ALLOWED_CIDRS 配置无效");
  const mask = Number(prefix) === 0 ? 0 : (0xffffffff << (32 - Number(prefix))) >>> 0;
  return ((ipNumber(address) & mask) >>> 0) === ((ipNumber(base) & mask) >>> 0);
}

/**
 * 校验摄像头只能位于明确允许的私有局域网；默认取 BFF 网卡直连网段，拒绝 DNS、回环和公网。
 * @param {unknown} host 必填，IPv4 字符串，不接受主机名、URL 或 IPv6。
 * @returns {string} 通过白名单校验的 IPv4。
 * @throws {HttpError} 非私网或不在允许网段时 400。
 */
function validateHost(host) {
  if (typeof host !== "string" || net.isIP(host) !== 4 || !["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some((cidr) => inCidr(host, cidr))) {
    throw badRequest("摄像头地址必须是局域网私有 IPv4");
  }
  const localCidrs = Object.values(os.networkInterfaces()).flat().filter((item) => item && !item.internal && item.family === "IPv4").map((item) => item.cidr).filter(Boolean);
  if (!(config.camera.allowedCidrs.length ? config.camera.allowedCidrs : localCidrs).some((cidr) => inCidr(host, cidr))) {
    throw badRequest("摄像头不在服务端允许的局域网网段，请检查 CAMERA_ALLOWED_CIDRS");
  }
  return host;
}

/**
 * 验证设备返回的 ONVIF HTTP 服务地址，固定同一 IP，阻止跨设备跳转和 URL 凭据。
 * @param {string} value 必填，设备服务 URL。
 * @param {string} host 必填，已验证的设备 IPv4。
 * @returns {URL} 同设备 HTTP URL；不发出请求。
 * @throws {HttpError} 协议、地址或路径不安全时 400。
 */
function deviceUrl(value, host) {
  let url;
  try { url = new URL(value); } catch { throw badRequest("设备返回了无效的服务地址"); }
  if (url.protocol !== "http:" || url.hostname !== host || url.username || url.password || url.hash) throw badRequest("设备服务必须是同一局域网 IP 的 HTTP 地址");
  validateHost(host);
  return url;
}

/**
 * 转义 SOAP 字段中的 XML 特殊字符。
 * @param {unknown} value 必填，待编码字段。
 * @returns {string} XML 文本安全值，无副作用。
 */
function xml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);
}

/**
 * 为 HTTP/RTSP Digest 生成认证头；支持 MD5 与 SHA-256、qop=auth，拒绝未知算法。
 * @param {string} challenge 必填，WWW-Authenticate Digest 内容。
 * @param {string} method 必填，HTTP/RTSP 请求方法。
 * @param {string} uri 必填，实际请求 URI。
 * @param {{username:string,password:string}} credentials 必填，解密后的设备凭据。
 * @returns {string} Authorization 值，不记录或持久化明文。
 * @throws {HttpError} 不支持的认证算法时 502。
 */
function digest(challenge, method, uri, credentials) {
  const fields = Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((match) => [match[1], match[2] ?? match[3]]));
  const algorithm = (fields.algorithm || "MD5").toUpperCase();
  if (!["MD5", "SHA-256"].includes(algorithm)) throw new HttpError(502, "CAMERA_AUTH", "设备认证算法暂不支持");
  const hash = (value) => crypto.createHash(algorithm === "MD5" ? "md5" : "sha256").update(value).digest("hex");
  const cnonce = crypto.randomBytes(12).toString("hex");
  const qop = fields.qop?.split(",").map((value) => value.trim()).includes("auth") ? "auth" : "";
  const ha1 = hash(`${credentials.username}:${fields.realm}:${credentials.password}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = hash(qop ? `${ha1}:${fields.nonce}:00000001:${cnonce}:auth:${ha2}` : `${ha1}:${fields.nonce}:${ha2}`);
  return `Digest username="${credentials.username.replace(/["\\\r\n]/g, "")}", realm="${fields.realm}", nonce="${fields.nonce}", uri="${uri}", response="${response}", algorithm=${algorithm}${qop ? `, qop=auth, nc=00000001, cnonce="${cnonce}"` : ""}${fields.opaque ? `, opaque="${fields.opaque}"` : ""}`;
}

/**
 * 向已校验地址发出有超时和响应上限的 SOAP HTTP 请求，不跟随重定向。
 * @param {URL} url 必填，固定设备地址。
 * @param {string} body 必填，完整 SOAP UTF-8 文本。
 * @param {string} actionUri 必填，服务代码生成的 ONVIF 操作 URI。
 * @param {string} [authorization] 可选，HTTP Digest 认证头。
 * @returns {Promise<{status:number,headers:object,body:string}>} 最大 2 MiB 的响应。
 * @throws {HttpError} 网络错误、超时或超长响应统一返回 502。
 */
function soapRequest(url, body, actionUri, authorization) {
  return new Promise((resolve, reject) => {
    const failure = () => reject(new HttpError(502, "CAMERA_NETWORK", "无法连接摄像头 ONVIF 服务，请检查端口、凭据和设备协议设置"));
    const request = http.request(url, { method: "POST", headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="${actionUri}"`, SOAPAction: `"${actionUri}"`, "Content-Length": Buffer.byteLength(body), ...(authorization ? { Authorization: authorization } : {}) } }, (response) => {
      let size = 0;
      const chunks = [];
      response.on("data", (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
      response.on("error", failure);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.setTimeout(6000, () => request.destroy());
    request.on("error", failure);
    request.end(body);
  });
}

/**
 * 调用 ONVIF SOAP 操作，同时兼容 WS-Security PasswordDigest 和 HTTP Digest。
 * @param {object} camera 必填，含 host、onvif_port 的后端设备记录。
 * @param {{username:string,password:string}} credentials 必填，仅内存使用的凭据。
 * @param {string} action 必填，受服务代码控制的 SOAP XML 操作，不接受直接客户端 XML。
 * @param {string} [endpoint] 可选，设备报告的同 IP 服务端点。
 * @returns {Promise<object>} SOAP Body 对象；有网络副作用。
 * @throws {HttpError} 设备拒绝认证、协议不支持、故障或 XML 异常为 502。
 */
async function soap(camera, credentials, action, endpoint) {
  const url = deviceUrl(endpoint || `http://${camera.host}:${camera.onvif_port}/onvif/device_service`, camera.host);
  const nonce = crypto.randomBytes(20);
  const created = new Date().toISOString();
  const passwordDigest = crypto.createHash("sha1").update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(credentials.password)])).digest("base64");
  const security = `<s:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${xml(credentials.username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${passwordDigest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
  const body = `<s:Envelope ${namespaces}>${security}<s:Body>${action}</s:Body></s:Envelope>`;
  const operation = action.match(/^<(tds|trt|trc|trp):(\w+)/);
  const services = { tds: "device", trt: "media", trc: "recording", trp: "replay" };
  if (!operation) throw badRequest("无效的设备服务操作");
  const actionUri = `http://www.onvif.org/ver10/${services[operation[1]]}/wsdl/${operation[2]}`;
  let response = await soapRequest(url, body, actionUri);
  if (response.status === 401 && /^Digest /i.test(response.headers["www-authenticate"] || "")) response = await soapRequest(url, body, actionUri, digest(response.headers["www-authenticate"], "POST", `${url.pathname}${url.search}`, credentials));
  try {
    const parsed = parser.parse(response.body)?.Envelope?.Body;
    if (response.status !== 200 || !parsed || parsed.Fault) throw new Error("SOAP fault");
    return parsed;
  } catch {
    throw new HttpError(502, "CAMERA_ONVIF", "设备未开放所需 ONVIF 服务，或账号密码/设备时间不正确");
  }
}

/**
 * 按数组形式规范化 ONVIF 单项或多项响应。
 * @param {unknown} value 可选，解析后的单项、多项或空值。
 * @returns {Array} 数组，不修改输入。
 */
function array(value) { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]; }

/**
 * 读取设备信息、媒体配置与可选录像服务；仅显式连接时调用，不轮询明文密码。
 * @param {object} camera 必填，后端设备记录。
 * @param {object} credentials 必填，设备用户名和密码。
 * @returns {Promise<object>} 厂商、型号、通道 token、RTSP URI 以及录像服务端点，仅供后端使用。
 * @throws {HttpError} ONVIF 不可用时抛出 502。
 */
async function inspect(camera, credentials) {
  const capabilities = (await soap(camera, credentials, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>')).GetCapabilitiesResponse?.Capabilities;
  const media = capabilities?.Media?.XAddr;
  if (!media) throw badRequest("设备没有可用的 ONVIF 媒体服务，请手动填写 RTSP 路径");
  const profiles = array((await soap(camera, credentials, "<trt:GetProfiles/>", media)).GetProfilesResponse?.Profiles);
  const streams = [];
  for (const profile of profiles.slice(0, 8)) {
    const token = String(profile["@_token"] || "");
    const result = await soap(camera, credentials, `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${xml(token)}</trt:ProfileToken></trt:GetStreamUri>`, media);
    streams.push({ token, name: String(profile.Name || token), uri: result.GetStreamUriResponse?.MediaUri?.Uri });
  }
  return { streams, recording: capabilities?.Extension?.Recording?.XAddr, replay: capabilities?.Extension?.Replay?.XAddr };
}

/**
 * 在服务器各私网网卡上发送 WS-Discovery Probe，限制 4 秒、256 个结果与单包大小；不会扫描公网。
 * @returns {Promise<object[]>} 发现的 IPv4、ONVIF 端口和名称，发现不代表已认证或支持录像。
 * @throws {HttpError} 无可用网卡或 UDP 不可用时抛出 503。
 */
async function discover() {
  const interfaces = Object.values(os.networkInterfaces()).flat().filter((item) => item && !item.internal && item.family === "IPv4");
  const results = new Map();
  await Promise.all(interfaces.map((item) => new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const timer = setTimeout(() => { socket.close(); resolve(); }, 4000);
    socket.on("error", () => { clearTimeout(timer); socket.close(); resolve(); });
    socket.on("message", (message, remote) => {
      if (message.length > 60000 || results.size >= 256) return;
      try {
        validateHost(remote.address);
        const matches = array(parser.parse(message.toString("utf8"))?.Envelope?.Body?.ProbeMatches?.ProbeMatch);
        for (const match of matches) {
          for (const endpoint of String(match.XAddrs || "").split(/\s+/)) {
            const url = deviceUrl(endpoint, remote.address);
            results.set(`${remote.address}:${url.port || 80}`, { host: remote.address, onvifPort: Number(url.port || 80), name: decodeURIComponent(String(match.Scopes || "").match(/onvif:\/\/www.onvif.org\/name\/([^\s]+)/)?.[1] || "发现的摄像头") });
          }
        }
      } catch { /* 不可信 UDP 响应按无效报文忽略，不影响其他设备发现。 */ }
    });
    socket.bind(0, item.address, () => {
      try {
        socket.setMulticastInterface(item.address);
        socket.setMulticastTTL(1);
        const probe = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><s:Header><a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID><a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action></s:Header><s:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></s:Body></s:Envelope>`;
        socket.send(probe, 3702, "239.255.255.250");
      } catch { clearTimeout(timer); socket.close(); resolve(); }
    });
  })));
  if (!interfaces.length) throw new HttpError(503, "CAMERA_DISCOVERY", "服务器没有可用的 IPv4 局域网网卡");
  return [...results.values()];
}

module.exports = { validateHost, inCidr, deviceUrl, soap, inspect, discover, xml, array, digest };
