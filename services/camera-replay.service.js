"use strict";

const net = require("net");
const { digest, validateHost } = require("./camera-network.service");
const { HttpError } = require("../lib/http-error");

/**
 * 按 RTSP Content-Length 和 TCP interleaved 长度拆帧，避免修改 RTP 二进制内容。
 * @param {(frame:Buffer,binary:boolean)=>void} consume 必填，完整报文处理器，允许修改 RTSP 文本。
 * @returns {(chunk:Buffer)=>void} socket data 处理器；超过 2 MiB 缓冲时抛出错误。
 */
function frameReader(consume) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 2 * 1024 * 1024) throw new Error("RTSP frame too large");
    while (buffer.length) {
      const binary = buffer[0] === 36;
      let length;
      if (binary) {
        if (buffer.length < 4) break;
        length = 4 + buffer.readUInt16BE(2);
      } else {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) break;
        const contentLength = Number(buffer.subarray(0, end).toString().match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1] || 0);
        length = end + 4 + contentLength;
      }
      if (buffer.length < length) break;
      const frame = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      consume(frame, binary);
    }
  };
}

/**
 * 替换 RTSP 消息正文或头部后重算 Content-Length，不改动二进制媒体帧。
 * @param {string} message 必填，含 CRLF 分隔的 RTSP 消息。
 * @returns {Buffer} 正确长度的 UTF-8 消息。
 */
function encodeMessage(message) {
  const index = message.indexOf("\r\n\r\n");
  const head = message.slice(0, index);
  const body = message.slice(index + 4);
  return Buffer.from(`${head.replace(/Content-Length:\s*\d+/i, `Content-Length: ${Buffer.byteLength(body)}`)}\r\n\r\n${body}`);
}

/**
 * 为 ONVIF Profile G 建立仅环回可访问的 RTSP/TCP 回放桥：PLAY 使用绝对 UTC 时段并重算 Digest。
 * 每座桥只允许一个 FFmpeg 连接；禁止代理任意客户端地址，销毁时关闭所有 socket。
 * @param {string} uri 必填，已验证的同设备 RTSP URL，不包含凭据。
 * @param {{username:string,password:string}} credentials 必填，内存中的设备凭据。
 * @param {{start:string,end:string}} range 必填，ISO-8601 UTC 回放时间区间。
 * @returns {Promise<{url:string,close:Function}>} 内部 FFmpeg 地址和同步清理函数，不得返回浏览器。
 * @throws {HttpError} 无法监听本地端口时 503；连接失败通过流进程状态反馈。
 */
async function createReplayBridge(uri, credentials, range) {
  const target = new URL(uri);
  validateHost(target.hostname);
  const sockets = new Set();
  let accepted = false;
  let localAuthority;
  let challenge = "";
  const server = net.createServer((client) => {
    if (accepted) { client.destroy(); return; }
    accepted = true;
    const remote = net.connect({ host: target.hostname, port: Number(target.port || 554) });
    sockets.add(client);
    sockets.add(remote);
    const close = () => { client.destroy(); remote.destroy(); sockets.delete(client); sockets.delete(remote); };
    client.setTimeout(30000, close);
    remote.setTimeout(30000, close);
    client.on("error", close);
    remote.on("error", close);
    client.on("close", close);
    remote.on("close", close);
    const upstream = frameReader((frame, binary) => {
      if (binary) { remote.write(frame); return; }
      let message = frame.toString("utf8").split(localAuthority).join(target.host);
      const [method, requestUri] = message.split(" ");
      if (challenge && /^Digest /i.test(challenge)) {
        message = message.replace(/\r\nAuthorization:[^\r\n]*/i, "");
        message = message.replace("\r\n", `\r\nAuthorization: ${digest(challenge, method, requestUri, credentials)}\r\n`);
      }
      if (method === "PLAY") {
        message = message.replace(/\r\nRange:[^\r\n]*/gi, "").replace(/\r\nRequire:[^\r\n]*/gi, "");
        const clock = (value) => value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
        message = message.replace("\r\n", `\r\nRange: clock=${clock(range.start)}-${clock(range.end)}\r\nRequire: onvif-replay\r\nRate-Control: yes\r\n`);
      }
      if (!remote.write(encodeMessage(message))) client.pause();
    });
    const downstream = frameReader((frame, binary) => {
      if (binary) { if (!client.write(frame)) remote.pause(); return; }
      let message = frame.toString("utf8");
      challenge = message.match(/\r\nWWW-Authenticate:\s*([^\r\n]+)/i)?.[1] || challenge;
      message = message.split(target.host).join(localAuthority);
      if (!client.write(encodeMessage(message))) remote.pause();
    });
    client.on("data", (chunk) => { try { upstream(chunk); } catch { close(); } });
    remote.on("data", (chunk) => { try { downstream(chunk); } catch { close(); } });
    remote.on("drain", () => client.resume());
    client.on("drain", () => remote.resume());
  });
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new HttpError(503, "CAMERA_REPLAY_BRIDGE", "无法建立设备本地回放通道")));
    server.listen(0, "127.0.0.1", resolve);
  });
  localAuthority = `127.0.0.1:${server.address().port}`;
  const local = new URL(`rtsp://${localAuthority}${target.pathname}${target.search}`);
  local.username = credentials.username;
  local.password = credentials.password;
  return { url: local.toString(), close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

module.exports = { createReplayBridge, frameReader, encodeMessage };
