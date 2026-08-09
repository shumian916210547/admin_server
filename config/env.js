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

function boolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

function originList(value, fallback) {
  const origins = (value || fallback)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!origins.length || origins.includes("*")) {
    throw new Error("CORS_ORIGINS must contain one or more explicit origins, never '*'");
  }

  return origins;
}

const publicOrigin = process.env.PUBLIC_ORIGIN || (isProduction ? required("PUBLIC_ORIGIN") : "http://localhost:4200");
const internalHost = process.env.PARSE_INTERNAL_HOST || "127.0.0.1";
const internalPort = integer("PARSE_INTERNAL_PORT", 1337);
const config = Object.freeze({
  environment: process.env.NODE_ENV || "development",
  isProduction,
  port: integer("PORT", 3000),
  trustProxy: boolean("TRUST_PROXY"),
  publicOrigin,
  allowedOrigins: originList(process.env.CORS_ORIGINS, publicOrigin),
  parse: {
    appId: required("PARSE_APP_ID"),
    masterKey: required("PARSE_MASTER_KEY"),
    databaseUri: required("DATABASE_URI"),
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
});

module.exports = { config };
