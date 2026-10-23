const path = require("path");

require("dotenv").config({
  path: process.env.ENV_FILE || path.resolve(process.cwd(), ".env"),
});

const isProduction = process.env.NODE_ENV === "production";

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function integer(name, fallback, min = 1) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer greater than or equal to ${min}`);
  }
  return value;
}

/**
 * 读取一个有上下限的整数配置，避免资源保护参数被设置为无界值。
 * @param {string} name 环境变量名称。
 * @param {number} fallback 未设置时使用的安全默认值。
 * @param {number} min 允许的最小整数值。
 * @param {number} max 允许的最大整数值。
 * @returns {number} 通过范围校验的配置值。
 * @throws {Error} 配置不是整数或超出范围时抛出。
 */
function boundedInteger(name, fallback, min, max) {
  const value = integer(name, fallback, min);
  if (value > max) throw new Error(`${name} must be less than or equal to ${max}`);
  return value;
}

function boolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

/**
 * 解析显式来源白名单，拒绝通配符，避免凭据请求被任意站点跨源发起。
 * @param {string | undefined} value 环境变量中的逗号分隔来源列表。
 * @param {string} fallback 未设置环境变量时使用的默认来源。
 * @param {string} name 配置项名称，用于生成错误提示。
 * @returns {string[]} 去空白且非空的来源数组。
 * @throws {Error} 来源为空或包含通配符时抛出。
 */
function originList(value, fallback, name) {
  const origins = (value || fallback)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!origins.length || origins.includes("*")) {
    throw new Error(`${name} must contain one or more explicit origins, never '*'`);
  }

  return origins;
}

/**
 * 校验供服务端到服务端或浏览器访问的 URL，拒绝带账号密码和非 HTTP(S) 协议的地址。
 * @param {string | undefined} value 环境变量中的 URL 文本；未配置时允许为空。
 * @param {string} name 环境变量名称，用于生成清晰的错误信息。
 * @returns {string} 去除首尾空格后的合法 URL；未配置时返回空字符串。
 * @throws {Error} URL 格式、协议或凭据部分不符合安全要求时抛出。
 */
function optionalHttpUrl(value, name) {
  if (value === undefined || value === null || !String(value).trim()) return "";
  const normalized = String(value).trim();
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be a credential-free HTTP(S) URL`);
  }
  return normalized.replace(/\/$/, "");
}

const publicOrigin = process.env.PUBLIC_ORIGIN || (isProduction ? required("PUBLIC_ORIGIN") : "http://localhost:4200");
// 协同 API 未单独配置来源时继承通用 CORS 白名单，避免开发服务器或受信局域网入口因默认值不一致而被误拒绝。
const collabOriginSource = process.env.COLLAB_ALLOWED_ORIGINS || process.env.CORS_ORIGINS || publicOrigin;
const internalHost = process.env.PARSE_INTERNAL_HOST || "127.0.0.1";
const internalPort = integer("PARSE_INTERNAL_PORT", 1337);
const parseDatabaseUri = required("DATABASE_URI");
const officeBrowserUrl = optionalHttpUrl(process.env.OFFICE_DOCUMENT_SERVER_URL, "OFFICE_DOCUMENT_SERVER_URL");
const officeInternalUrl = optionalHttpUrl(process.env.OFFICE_INTERNAL_URL, "OFFICE_INTERNAL_URL");
const officeJwtSecret = officeBrowserUrl || officeInternalUrl ? required("OFFICE_JWT_SECRET") : "";
if (process.env.CAMERA_ENCRYPTION_KEY?.trim() && !/^[A-Za-z0-9+/]{43}=$/.test(process.env.CAMERA_ENCRYPTION_KEY.trim())) {
  throw new Error("CAMERA_ENCRYPTION_KEY must be a Base64-encoded 32-byte random key");
}
const config = Object.freeze({
  environment: process.env.NODE_ENV || "development",
  isProduction,
  port: integer("PORT", 3000),
  trustProxy: boolean("TRUST_PROXY"),
  publicOrigin,
  allowedOrigins: originList(process.env.CORS_ORIGINS, publicOrigin, "CORS_ORIGINS"),
  parse: {
    appId: required("PARSE_APP_ID"),
    masterKey: required("PARSE_MASTER_KEY"),
    databaseUri: parseDatabaseUri,
    internalHost,
    internalPort,
    serverUrl:
      process.env.PARSE_INTERNAL_URL || `http://${internalHost}:${internalPort}/parse`,
  },
  auth: {
    jwtSecret: required("AUTH_JWT_SECRET"),
    cookieName: process.env.AUTH_COOKIE_NAME || "shumian_admin_session",
    // 会话采用 30 天滑动窗口；部署环境仍可通过 AUTH_TTL_SECONDS 显式缩短有效期。
    ttlSeconds: integer("AUTH_TTL_SECONDS", 30 * 24 * 60 * 60),
  },
  upload: {
    maxBytes: integer("UPLOAD_MAX_BYTES", 10 * 1024 * 1024),
    storageDir: path.resolve(process.cwd(), process.env.UPLOAD_STORAGE_DIR || "resources"),
  },
  // IPC 凭据使用独立 AES-256 密钥；留空时禁用设备写入，避免使用会话密钥加密设备密码。
  camera: {
    storageDir: path.resolve(process.cwd(), process.env.CAMERA_STORAGE_DIR || "resources/cameras"),
    encryptionKey: process.env.CAMERA_ENCRYPTION_KEY?.trim() || "",
    allowedCidrs: (process.env.CAMERA_ALLOWED_CIDRS || "").split(",").map((value) => value.trim()).filter(Boolean),
    ffmpegPath: process.env.CAMERA_FFMPEG_PATH || "ffmpeg",
    maxStreams: boundedInteger("CAMERA_MAX_STREAMS", 8, 1, 64),
    // 实时预览独立预留至少 16 路，录像使用 maxStreams，避免 16 分屏被原有 8 路录像上限截断。
    maxLiveStreams: boundedInteger("CAMERA_MAX_LIVE_STREAMS", 32, 16, 128),
    maxStorageBytes: boundedInteger("CAMERA_MAX_STORAGE_MB", 10240, 256, 1048576) * 1024 * 1024,
    retentionDays: boundedInteger("CAMERA_RETENTION_DAYS", 7, 1, 365),
  },
  collab: {
    databaseUri: process.env.COLLAB_DATABASE_URI?.trim() || parseDatabaseUri,
    storageDir: path.resolve(process.cwd(), process.env.COLLAB_STORAGE_DIR || "resources/collab"),
    maxFileBytes: boundedInteger("COLLAB_MAX_FILE_BYTES", 50 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    maxWsConnections: boundedInteger("COLLAB_WS_MAX_CONNECTIONS", 1_000, 1, 100_000),
    snapshotInterval: boundedInteger("COLLAB_SNAPSHOT_INTERVAL", 250, 1, 10_000),
    maxListPageSize: boundedInteger("COLLAB_MAX_LIST_PAGE_SIZE", 100, 1, 100),
    allowedOrigins: originList(collabOriginSource, publicOrigin, "COLLAB_ALLOWED_ORIGINS"),
    office: {
      browserUrl: officeBrowserUrl,
      internalUrl: officeInternalUrl,
      jwtSecret: officeJwtSecret,
    },
  },
});

module.exports = { config };
