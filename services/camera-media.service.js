"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const { config } = require("../config/env");
const { badRequest, notFound, HttpError } = require("../lib/http-error");
const logger = require("../lib/logger");
const cameras = require("./camera.service");
const network = require("./camera-network.service");
const db = require("./camera-db.service");
const { createReplayBridge } = require("./camera-replay.service");

/** HLS 会话只在内存保留；录像任务每段最多五分钟，128 MiB，避免无界写盘。 */
const sessions = new Map();
const recordings = new Map();
const recordingErrors = new Map();
const pendingDevices = new Set();
/** 设备连接代次：配置停止时递增，阻止正在等待 ONVIF/磁盘的旧请求随后启动旧连接。 */
const deviceVersions = new Map();
const chunkBytes = 128 * 1024 * 1024;
let worker;
let ticking = false;
let closing = false;
let ffmpegAvailable;
let pendingStreams = 0;

/**
 * 验证并取得私有媒体子路径，所有目录片段均由服务端常量或 UUID 生成。
 * @param {...string} parts 必填，受控相对目录片段；不允许用户原始路径。
 * @returns {string} 存储根内的绝对路径。
 * @throws {HttpError} 路径越界时 400。
 */
function storagePath(...parts) {
  const root = config.camera.storageDir;
  const result = path.resolve(root, ...parts);
  if (!result.startsWith(`${root}${path.sep}`)) throw badRequest("无效媒体路径");
  return result;
}

/**
 * 检查本地 FFmpeg 是否可执行，缓存成功结果；失败不泄露可执行文件路径。
 * @returns {Promise<void>} FFmpeg 可用时兑现，无摄像头网络访问。
 * @throws {HttpError} 未安装或配置错误时 503。
 */
async function requireFfmpeg() {
  if (ffmpegAvailable) return;
  try { await promisify(execFile)(config.camera.ffmpegPath, ["-version"], { timeout: 5000, windowsHide: true, maxBuffer: 65536 }); ffmpegAvailable = true; }
  catch { throw new HttpError(503, "CAMERA_FFMPEG", "服务器未安装 FFmpeg，请安装包含 libx264 的 FFmpeg 并配置 CAMERA_FFMPEG_PATH"); }
}

/**
 * 构造经过局域网校验的 RTSP 输入，凭据只传给后端子进程，不回传浏览器或日志。
 * @param {object} camera 必填，数据库设备记录。
 * @returns {string} 带 URL 编码账号密码的 RTSP URI。
 * @throws {HttpError} 地址不在允许网段或密钥无效时抛出。
 */
function rtspUrl(camera) {
  network.validateHost(camera.host);
  const credentials = cameras.decrypt(camera.credentials);
  const url = new URL(`rtsp://${camera.host}:${camera.rtsp_port}${cameras.rtspPath(camera.rtsp_path)}`);
  url.username = credentials.username;
  url.password = credentials.password;
  return url.toString();
}

/**
 * 启动固定参数的 FFmpeg，不使用 shell；禁止文件/HTTP 等输入协议，限制网络读取超时。
 * @param {string} input 必填，内部生成的 RTSP URI。
 * @param {string[]} output 必填，服务端固定的转码/封装及输出参数。
 * @returns {import("child_process").ChildProcess} 运行进程；不采集或记录可能包含密码的 stderr。
 */
function launch(input, output) {
  return spawn(config.camera.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "2", "-filter_threads", "1", "-protocol_whitelist", "rtsp,tcp,udp,rtp,crypto", "-rtsp_transport", "tcp", "-timeout", "10000000", "-i", input, ...output], { windowsHide: true, stdio: "ignore" });
}

/**
 * 验证设备历史录像的时间范围，限制最多一小时，避免无界回放会话。
 * @param {object} input 必填，start/end 为带时区的 ISO-8601 字符串。
 * @returns {{start:string,end:string}} 规范化 UTC 区间。
 * @throws {HttpError} 格式、顺序、未来时间或时长非法时 400。
 */
function timeRange(input) {
  if (![input?.start, input?.end].every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) throw badRequest("请选择含时区的录像开始和结束时间");
  const start = new Date(input.start);
  const end = new Date(input.end);
  const duration = end - start;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600000 || end.getTime() > Date.now() + 60000) throw badRequest("回放区间必须为过去的 1 小时以内，结束时间须晚于开始时间");
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * 查询 Profile G 录像 token 与可用时间，不使用前端猜测设备能力。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，摄像头 UUID。
 * @returns {Promise<object>} 录像 token、起止时间及厂商路径回放能力；无录像写入。
 * @throws {HttpError} 页面权限、ONVIF 或设备能力不足时拒绝。
 */
async function deviceRecordings(auth, id) {
  await cameras.authorize(auth);
  const camera = await cameras.get(auth, id);
  const credentials = cameras.decrypt(camera.credentials);
  let capabilities;
  try { capabilities = (await network.soap(camera, credentials, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>')).GetCapabilitiesResponse?.Capabilities; }
  catch (error) {
    if (!["hikvision", "dahua"].includes(camera.brand)) throw error;
    return { recordings: [], vendorPlayback: true, message: "ONVIF 录像服务不可用，可按通道和时间尝试厂商 RTSP 本地回放；请确认设备已有录像。" };
  }
  const recording = capabilities?.Extension?.Recording?.XAddr;
  const replay = capabilities?.Extension?.Replay?.XAddr;
  if (!recording || !replay) {
    if (["hikvision", "dahua"].includes(camera.brand)) return { recordings: [], vendorPlayback: true, message: "设备未报告 Profile G，可按通道和时间尝试厂商本地回放；仅有录像的通道有效。" };
    throw badRequest("设备未开放 ONVIF Profile G 录像服务；请确认型号、账号权限与 SD 卡/NVR 配置");
  }
  const result = await network.soap(camera, credentials, "<trc:GetRecordings/>", recording);
  return { vendorPlayback: ["hikvision", "dahua"].includes(camera.brand), recordings: network.array(result.GetRecordingsResponse?.RecordingItem).slice(0, 128).map((item) => ({ token: String(item.RecordingToken), name: String(item.Configuration?.Content || item.Configuration?.Source?.Name || item.RecordingToken), tracks: network.array(item.Tracks?.Track).map((track) => ({ token: String(track.TrackToken), type: String(track.Configuration?.TrackType || "") })) })) };
}

/**
 * 为设备历史录像构造本地 RTSP 回放输入；优先使用指定 Profile G token，否则仅使用已知厂商路径。
 * @param {object} camera 必填，当前租户设备记录。
 * @param {object} options 必填，start/end 与可选 recordingToken、channel（1 至 256）。
 * @returns {Promise<{url:string,close:Function}>} 内部输入 URL 和清理函数。
 * @throws {HttpError} 参数、设备能力或网络失败时抛出。
 */
async function replayInput(camera, options) {
  const range = timeRange(options);
  const credentials = cameras.decrypt(camera.credentials);
  if (options.recordingToken) {
    const token = options.recordingToken;
    if (typeof token !== "string" || token.length > 256) throw badRequest("录像 token 无效");
    const capabilities = (await network.soap(camera, credentials, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>')).GetCapabilitiesResponse?.Capabilities;
    const endpoint = capabilities?.Extension?.Replay?.XAddr;
    if (!endpoint) throw badRequest("设备未开放 ONVIF 回放服务");
    const response = await network.soap(camera, credentials, `<trp:GetReplayUri><trp:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trp:StreamSetup><trp:RecordingToken>${network.xml(token)}</trp:RecordingToken></trp:GetReplayUri>`, endpoint);
    const address = cameras.streamAddress(response.GetReplayUriResponse?.Uri, camera.host);
    return createReplayBridge(`rtsp://${camera.host}:${address.port}${address.path}`, credentials, range);
  }
  if (!["hikvision", "dahua"].includes(camera.brand)) throw badRequest("请选择设备返回的 Profile G 录像 token");
  const channel = options.channel;
  if (!Number.isInteger(channel) || channel < 1 || channel > 256) throw badRequest("设备回放通道必须为 1 至 256");
  const stamp = (value) => value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  // 海康 ISAPI RTSP 以 UTC 紧凑时间查询；大华 RTSP 以设备本地时间查询，客户端必须给出设备偏移分钟。
  let replayPath = `/Streaming/tracks/${channel}01?starttime=${stamp(range.start)}&endtime=${stamp(range.end)}`;
  if (camera.brand === "dahua") {
    const offset = options.deviceUtcOffsetMinutes;
    if (!Number.isInteger(offset) || offset < -720 || offset > 840) throw badRequest("请填写设备 UTC 时区偏移分钟数，例如中国标准时间为 480");
    const local = (value) => new Date(new Date(value).getTime() + offset * 60000).toISOString().slice(0, 19).replace(/[-T:]/g, "_");
    replayPath = `/cam/playback?channel=${channel}&subtype=0&starttime=${local(range.start)}&endtime=${local(range.end)}`;
  }
  return { url: rtspUrl({ ...camera, rtsp_path: replayPath }), close: () => {} };
}

/**
 * 启动 HLS 实时预览或设备历史回放，分配受会话用户绑定的临时流，十秒内等待首个片段。
 * @param {object} auth 必填，可信会话，绑定 companyId/userId。
 * @param {string} id 必填，摄像头 UUID。
 * @param {object} [options={}] 可选，mode=device 时包含回放时间和录像 token/通道。
 * @param {AbortSignal} [signal] 可选，HTTP 客户端断开信号；取消后及时释放尚未返回的转码任务。
 * @returns {Promise<object>} 流 ID、同源播放地址和过期时间；启动转码进程和私有 HLS 文件。
 * @throws {HttpError} 并发上限、FFmpeg 缺失、输入失败或权限不足时拒绝并清理。
 */
async function startStream(auth, id, options = {}, signal) {
  await cameras.authorize(auth);
  cameras.uuid(id);
  const version = deviceVersions.get(id) || 0;
  if (sessions.size + pendingStreams >= config.camera.maxLiveStreams) throw new HttpError(429, "CAMERA_CAPACITY", "实时预览并发已达服务器上限，请关闭其他画面或联系管理员扩容");
  pendingStreams += 1;
  let session;
  let input;
  try {
    await requireFfmpeg();
    const camera = await cameras.get(auth, id);
    input = options.mode === "device" ? await replayInput(camera, options) : { url: rtspUrl(camera), close: () => {} };
    const streamId = crypto.randomUUID();
    const directory = storagePath("streams", streamId);
    await fs.mkdir(directory, { recursive: true });
    if (signal?.aborted) {
      await fs.rm(directory, { recursive: true, force: true });
      throw new HttpError(499, "CAMERA_CANCELLED", "播放请求已取消");
    }
    if (version !== (deviceVersions.get(id) || 0) || pendingDevices.has(id)) {
      await fs.rm(directory, { recursive: true, force: true });
      throw new HttpError(409, "CAMERA_CHANGED", "设备配置已变更，请重新打开播放");
    }
    // 分屏默认使用流畅档输出，降低多路转码与浏览器解码压力；不会自动修改设备自身码流配置。
    const fluent = options.quality === "fluent";
    const process = launch(input.url, ["-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-vf", `scale=trunc(min(${fluent ? 640 : 1280}\\,iw)/2)*2:-2`, "-pix_fmt", "yuv420p", "-r", fluent ? "12" : "20", "-g", fluent ? "24" : "40", "-b:v", fluent ? "500k" : "1500k", "-maxrate", fluent ? "750k" : "2000k", "-bufsize", fluent ? "1000k" : "3000k", ...(options.mode === "device" ? ["-t", String((new Date(options.end) - new Date(options.start)) / 1000)] : []), "-f", "hls", "-hls_time", "2", "-hls_list_size", options.mode === "device" ? "1800" : "6", "-hls_flags", options.mode === "device" ? "independent_segments" : "delete_segments+independent_segments", "-hls_segment_filename", path.join(directory, "%06d.ts"), path.join(directory, "index.m3u8")]);
    session = { id: streamId, cameraId: id, companyId: auth.companyId, userId: auth.userId, directory, process, input, lastAccess: Date.now(), expiresAt: Date.now() + 65 * 60000, failed: false, ended: false };
    sessions.set(streamId, session);
    process.on("error", () => { session.failed = true; });
    process.on("exit", (code) => { session.failed = code !== 0; session.ended = true; input.close(); });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (signal?.aborted) throw new HttpError(499, "CAMERA_CANCELLED", "播放请求已取消");
      if (session.failed) break;
      try { if ((await fs.stat(path.join(directory, "index.m3u8"))).size > 0) return { id: streamId, url: `/api/cameras/${id}/streams/${streamId}/index.m3u8`, expiresAt: new Date(session.expiresAt).toISOString() }; } catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new HttpError(502, "CAMERA_STREAM", "摄像头未返回可播放画面，请检查 RTSP 路径、设备密码、录像时段和编解码支持");
  } catch (error) {
    if (session) await disposeSession(session);
    else input?.close();
    throw error;
  } finally { pendingStreams -= 1; }
}

/**
 * 结束 HLS 会话并等待进程退出，再删除该会话受控目录。
 * @param {object} session 必填，内部流会话记录。
 * @returns {Promise<void>} 杀进程、关闭回放桥并移除临时文件；清理失败写脱敏日志。
 */
async function disposeSession(session) {
  sessions.delete(session.id);
  session.input.close();
  await stopProcess(session.process);
  try { await fs.rm(session.directory, { recursive: true, force: true }); }
  catch { logger.warn("camera.stream_cleanup_failed", { streamId: session.id }); }
}

/**
 * 停止本服务启动的子进程并等待退出，防止 Windows 文件占用引发清理竞态。
 * @param {import("child_process").ChildProcess} child 必填，本服务持有的子进程。
 * @returns {Promise<void>} 最迟三秒完成；只影响本服务的媒体进程。
 */
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGKILL");
  });
}

/**
 * 取得用户自己的 HLS 会话并再次验证设备租户和页面权限；会话不能跨账号复用。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，摄像头 UUID。
 * @param {string} streamId 必填，流 UUID。
 * @returns {Promise<object>} 活跃流；更新最后访问时间。
 * @throws {HttpError} 其他用户、跨租户、已过期或已失败时拒绝。
 */
async function getSession(auth, id, streamId) {
  await cameras.authorize(auth);
  await cameras.get(auth, id);
  const session = sessions.get(cameras.uuid(streamId));
  if (!session || session.cameraId !== id || session.companyId !== auth.companyId || session.userId !== auth.userId || Date.now() > session.expiresAt) throw notFound("播放会话已结束，请重新打开预览");
  if (session.failed) throw new HttpError(502, "CAMERA_STREAM_ENDED", "设备媒体连接已中断，请重新预览");
  session.lastAccess = Date.now();
  return session;
}

/**
 * 获取受认证保护的 HLS 文件路径，禁止任意目录遍历和未生成文件。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，设备 UUID。
 * @param {string} streamId 必填，流 UUID。
 * @param {string} filename 必填，仅 index.m3u8 或六位数字 .ts。
 * @returns {Promise<string>} 私有文件绝对路径。
 * @throws {HttpError} 文件名或会话无效时拒绝。
 */
async function streamFile(auth, id, streamId, filename) {
  if (!/^(index\.m3u8|\d{6}\.ts)$/.test(filename)) throw notFound();
  const session = await getSession(auth, id, streamId);
  const file = path.join(session.directory, filename);
  try { await fs.access(file); } catch { throw notFound("媒体片段暂不可用"); }
  return file;
}

/**
 * 用户主动关闭自己的预览；不存在的会话按幂等成功处理，仍校验设备权限。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，设备 UUID。
 * @param {string} streamId 必填，流 UUID。
 * @returns {Promise<void>} 释放转码和文件。
 * @throws {HttpError} 其他账号的会话或越权设备时拒绝。
 */
async function stopStream(auth, id, streamId) {
  // 释放连接只要求可信会话与所有权；成员刚被撤权/设备刚被移走时，仍应允许其释放已有任务。
  cameras.uuid(id);
  const session = sessions.get(cameras.uuid(streamId));
  if (!session) return;
  if (session.cameraId !== id || session.companyId !== auth.companyId || session.userId !== auth.userId) throw notFound();
  await disposeSession(session);
}

/**
 * 列出私有录像目录的完整文件；只遍历内部 UUID 目录，不跟随符号链接。
 * @param {string} [id] 可选，设备 UUID；缺省扫描全体设备用于全局配额维护。
 * @returns {Promise<object[]>} file、name、size、mtime 与 deviceId，未完成 .partial 文件不返回。
 * @throws {Error} 非目录不存在以外的文件系统错误向调用者抛出。
 */
async function recordingFiles(id) {
  const root = storagePath("recordings");
  let devices;
  try { devices = id ? [id] : (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[a-f\d-]{36}$/.test(entry.name)).map((entry) => entry.name); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const deviceId of devices) {
    let entries;
    try { entries = await fs.readdir(path.join(root, deviceId), { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d{13}-[a-f\d-]{36}\.mp4$/.test(entry.name)) continue;
      const file = path.join(root, deviceId, entry.name);
      try { const stat = await fs.stat(file); files.push({ file, name: entry.name, size: stat.size, mtime: stat.mtimeMs, deviceId }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return files;
}

/**
 * 返回当前租户设备已完成的本地录像及录像任务状态，最新 1000 段。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，设备 UUID。
 * @returns {Promise<object>} 完整录像的同源回放 URL、开始时间、字节数及状态；不返回磁盘路径。
 * @throws {HttpError} 越权或磁盘不可用时抛出。
 */
async function listRecordings(auth, id) {
  await cameras.authorize(auth);
  const camera = await cameras.get(auth, id);
  const files = (await recordingFiles(cameras.uuid(id))).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 1000);
  return { enabled: camera.recording_enabled, recording: recordings.has(id), error: recordingErrors.get(id) || "", files: files.map((file) => ({ name: file.name, size: file.size, start: new Date(Number(file.name.slice(0, 13))).toISOString(), url: `/api/cameras/${id}/recordings/${file.name}` })) };
}

/**
 * 校验本地录像文件请求，Range 由 Express sendFile 处理；每次请求重新做租户和权限校验。
 * @param {object} auth 必填，可信会话。
 * @param {string} id 必填，设备 UUID。
 * @param {string} filename 必填，服务端生成的时间戳-UUID.mp4 文件名。
 * @returns {Promise<string>} 受控文件绝对路径，不产生转码任务。
 * @throws {HttpError} 跨租户、遍历或文件不存在时拒绝。
 */
async function recordingFile(auth, id, filename) {
  await cameras.authorize(auth);
  await cameras.get(auth, id);
  if (!/^\d{13}-[a-f\d-]{36}\.mp4$/.test(filename)) throw notFound();
  const file = storagePath("recordings", cameras.uuid(id), filename);
  try { await fs.access(file); } catch { throw notFound("录像不存在或已按保留策略清理"); }
  return file;
}

/**
 * 按保留期和全局配额删除最旧的已完成录像，为现有任务和下一段预留 128 MiB 配额。
 * @param {boolean} [reserveNext=false] 可选，新增录像任务前为下一段额外预留空间。
 * @returns {Promise<void>} 会不可逆清理到期或超配额录像；不会删除正在写入的段。
 * @throws {HttpError} 预留空间不足时 507，文件系统错误原样抛出。
 */
async function enforceQuota(reserveNext = false) {
  const files = (await recordingFiles()).sort((a, b) => a.mtime - b.mtime);
  let size = files.reduce((sum, file) => sum + file.size, 0);
  const reserve = (recordings.size + (reserveNext ? 1 : 0)) * chunkBytes;
  const cutoff = Date.now() - config.camera.retentionDays * 86400000;
  for (const file of files) {
    if (file.mtime < cutoff || size + reserve > config.camera.maxStorageBytes) {
      await fs.unlink(file.file);
      size -= file.size;
    }
  }
  if (size + reserve > config.camera.maxStorageBytes) throw new HttpError(507, "CAMERA_DISK", "录像配额不足，等待其他录像段结束或调大 CAMERA_MAX_STORAGE_MB");
  const stat = await fs.statfs(config.camera.storageDir);
  if (stat.bavail * stat.bsize < reserve + 256 * 1024 * 1024) throw new HttpError(507, "CAMERA_DISK", "磁盘可用空间不足，已暂停新增录像段");
}

/**
 * 启动一段最多五分钟的 H.264 本地 MP4 录像；完成后原子改名供回放，不展示不完整文件。
 * @param {object} camera 必填，数据库中启用录像的内部设备记录。
 * @returns {Promise<void>} 启动后台任务；运行错误存为脱敏状态供页面读取。
 * @throws {HttpError|Error} FFmpeg、配额或目录不可用时抛出。
 */
async function startRecording(camera) {
  const version = deviceVersions.get(camera.id) || 0;
  await requireFfmpeg();
  await enforceQuota(true);
  const directory = storagePath("recordings", cameras.uuid(camera.id));
  await fs.mkdir(directory, { recursive: true });
  const name = `${Date.now()}-${crypto.randomUUID()}`;
  const partial = path.join(directory, `${name}.partial.mp4`);
  const output = path.join(directory, `${name}.mp4`);
  const current = await db.query("SELECT id FROM camera.devices WHERE id=$1 AND company_id=$2 AND recording_enabled=true AND date_trunc('milliseconds', updated_at)=$3", [camera.id, camera.company_id, camera.updated_at]);
  if (!current.rows.length || pendingDevices.has(camera.id) || version !== (deviceVersions.get(camera.id) || 0)) return;
  const child = launch(rtspUrl(camera), ["-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-vf", "scale=trunc(min(1280\\,iw)/2)*2:-2", "-pix_fmt", "yuv420p", "-b:v", "1500k", "-maxrate", "2000k", "-bufsize", "3000k", "-t", "300", "-fs", String(chunkBytes), "-movflags", "+faststart", partial]);
  const job = { process: child, partial, camera, cancelled: false, completion: null };
  recordings.set(camera.id, job);
  recordingErrors.delete(camera.id);
  child.on("error", () => { recordingErrors.set(camera.id, "录像进程无法启动，请检查 FFmpeg 配置"); });
  job.completion = new Promise((resolve) => {
    child.on("close", async (code) => {
      try {
        if (code === 0 && !job.cancelled) await fs.rename(partial, output);
        else {
          await fs.rm(partial, { force: true });
          if (!job.cancelled) recordingErrors.set(camera.id, "录像连接中断，请检查设备、RTSP 地址和磁盘空间，服务将自动重试");
        }
      } catch { recordingErrors.set(camera.id, "录像文件写入失败，请检查磁盘权限和空间"); }
      finally { if (recordings.get(camera.id) === job) recordings.delete(camera.id); resolve(); }
    });
  });
}

/**
 * 停止指定设备的全部媒体任务，供编辑、解除关联和关闭录像时复用。
 * @param {string} id 必填，设备 UUID；调用者必须先完成对应的写权限校验。
 * @returns {Promise<void>} 关闭预览与录像；当前未完成录像段会被丢弃，已完成录像保留。
 */
async function stopDevice(id) {
  deviceVersions.set(id, (deviceVersions.get(id) || 0) + 1);
  pendingDevices.add(id);
  try {
    for (const session of [...sessions.values()]) if (session.cameraId === id) await disposeSession(session);
    const job = recordings.get(id);
    if (job) { job.cancelled = true; await stopProcess(job.process); await job.completion; }
  } finally { pendingDevices.delete(id); }
}

/**
 * 每十五秒回收闲置流、清理录像保留期，并恢复数据库中启用的录像设备；串行执行防止配额竞态。
 * @returns {Promise<void>} 有子进程/磁盘副作用；故障以脱敏状态记录，不终止 BFF。
 */
async function tick() {
  if (ticking || closing) return;
  ticking = true;
  try {
    for (const session of [...sessions.values()]) if (Date.now() - session.lastAccess > 90000 || Date.now() > session.expiresAt || session.failed) await disposeSession(session);
    await fs.mkdir(config.camera.storageDir, { recursive: true });
    await cleanupAbandoned();
    const result = await db.query("SELECT *, host(host) AS host FROM camera.devices WHERE recording_enabled=true ORDER BY updated_at");
    const enabled = new Set(result.rows.map((camera) => camera.id));
    for (const id of recordings.keys()) if (!enabled.has(id)) await stopDevice(id);
    try { await enforceQuota(); }
    catch (error) { for (const camera of result.rows) recordingErrors.set(camera.id, error.status ? error.message : "录像维护失败，请检查磁盘空间"); return; }
    for (const camera of result.rows) {
      if (pendingDevices.has(camera.id) || recordings.has(camera.id) || recordings.size >= config.camera.maxStreams) continue;
      try { await startRecording(camera); }
      catch (error) { recordingErrors.set(camera.id, error.status ? error.message : "录像服务不可用，请检查磁盘配置"); }
    }
  } catch (error) {
    // 未执行迁移的旧部署无需在启动时失败；状态在访问摄像头页时通过受控 API 返回。
    for (const id of recordings.keys()) recordingErrors.set(id, error.status ? error.message : "录像维护失败，请检查磁盘空间");
  } finally { ticking = false; }
}

/**
 * 回收上次异常退出遗留的未完成录像和闲置 HLS 目录；不跟随符号链接，不触碰当前任务。
 * @returns {Promise<void>} 删除受控 UUID 子目录中的遗留文件；磁盘异常交给 tick 记录状态。
 */
async function cleanupAbandoned() {
  for (const group of ["recordings", "streams"]) {
    const root = storagePath(group);
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f\d-]{36}$/.test(entry.name)) continue;
      const directory = storagePath(group, entry.name);
      if (group === "streams") {
        if (!sessions.has(entry.name) && Date.now() - (await fs.stat(directory)).mtimeMs > 90000) await fs.rm(directory, { recursive: true, force: true });
      } else {
        for (const file of await fs.readdir(directory, { withFileTypes: true })) {
          if (file.isFile() && /^\d{13}-[a-f\d-]{36}\.partial\.mp4$/.test(file.name)) {
            const partial = path.join(directory, file.name);
            if (recordings.get(entry.name)?.partial !== partial) await fs.unlink(partial);
          }
        }
      }
    }
  }
}

/**
 * BFF 启动时启用本地录像守护与回收定时器，密钥未配置时不启动；无参数，可重复调用。
 * @returns {void} 启动不阻塞请求的定时任务；不自动扫描网络、不修改设备。
 */
function startWorker() {
  if (worker || !config.camera.encryptionKey) return;
  worker = setInterval(tick, 15000);
  worker.unref();
  tick();
}

/**
 * 在服务优雅退出时停止所有媒体进程与回放桥，无参数。
 * @returns {Promise<void>} 清理会话，当前未完成录像段被丢弃。
 */
async function close() {
  closing = true;
  clearInterval(worker);
  while (ticking) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const id of [...recordings.keys()]) await stopDevice(id);
  for (const session of [...sessions.values()]) await disposeSession(session);
}

/**
 * 读取当前用户的预览任务数，用于运维和隔离回归核对媒体资源释放，不返回其他成员会话或URL。
 * @param {object} auth 必填，可信 companyId/userId。
 * @returns {Promise<number>} 当前账号拥有的有效预览任务数，无写入。
 */
async function activePreviewCount(auth) { return [...sessions.values()].filter((session) => session.companyId === auth.companyId && session.userId === auth.userId).length; }

/**
 * 批量释放当前用户自己创建的流，供整页离开时的一次keepalive使用；不要求仍有设备读取权限。
 * @param {object} auth 必填，可信会话的 companyId/userId。
 * @param {object} input 必填，streams 为最多64条 {id,cameraId} UUID 记录。
 * @returns {Promise<{stopped:number}>} 关闭的自有任务数量；其他用户和不存在的ID均不透露细节。
 * @throws {HttpError} 格式无效或超过数量限制时400。
 */
async function stopOwnedStreams(auth, input) {
  if (!Array.isArray(input?.streams) || input.streams.length > 64) throw badRequest("每次最多释放64条视频连接");
  const owned = [];
  for (const stream of input.streams) {
    const id = cameras.uuid(stream?.id);
    const cameraId = cameras.uuid(stream?.cameraId);
    const session = sessions.get(id);
    if (session && session.cameraId === cameraId && session.companyId === auth.companyId && session.userId === auth.userId && !owned.includes(session)) owned.push(session);
  }
  await Promise.all(owned.map(disposeSession));
  return { stopped: owned.length };
}

module.exports = { startWorker, close, startStream, stopStream, streamFile, deviceRecordings, listRecordings, recordingFile, stopDevice, timeRange, requireFfmpeg, rtspUrl, activePreviewCount, stopOwnedStreams };
