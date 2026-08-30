const { config } = require("../config/env");
const { forbidden } = require("../lib/http-error");

/**
 * 判断请求是否属于协同领域，兼容应用级中间件和 /api 路由器内部的路径表现。
 * @param {import("express").Request} req 当前 HTTP 请求。
 * @returns {boolean} 请求目标为协同 API 时返回 true。
 */
function isCollabRequest(req) {
  const requestPath = String(req.originalUrl || req.baseUrl || req.path || "").split("?", 1)[0];
  return (
    requestPath === "/api/collab" ||
    requestPath.startsWith("/api/collab/") ||
    requestPath === "/collab" ||
    requestPath.startsWith("/collab/")
  );
}

/**
 * 返回当前请求应使用的明确来源白名单；协同 API 可使用独立于通用 API 的来源配置。
 * @param {import("express").Request} req 当前 HTTP 请求。
 * @returns {string[]} 当前请求的允许来源数组。
 */
function allowedOriginsForRequest(req) {
  return isCollabRequest(req) ? config.collab.allowedOrigins : config.allowedOrigins;
}

/**
 * 校验浏览器 Origin；缺少 Origin 的同源或服务端请求由既有安全策略继续处理。
 * @param {import("express").Request} req 当前 HTTP 请求。
 * @param {string | undefined} origin 请求 Origin。
 * @returns {boolean} Origin 为空或属于当前路径白名单时返回 true。
 */
function isAllowedOrigin(req, origin) {
  return !origin || allowedOriginsForRequest(req).includes(origin);
}

/**
 * 校验所有浏览器请求的 Origin，并为允许的跨源请求写入最小 CORS 响应头。
 * @param {import("express").Request} req 当前 HTTP 请求。
 * @param {import("express").Response} res 当前 HTTP 响应。
 * @param {import("express").NextFunction} next 继续路由或传递拒绝错误的 Express 回调。
 * @returns {void} 允许请求时继续；OPTIONS 请求直接返回 204。
 * @throws {import("../lib/http-error").HttpError} 来源不在当前 API 白名单时通过 next 传递 403。
 */
function originGuard(req, res, next) {
  const origin = req.get("origin");
  if (!isAllowedOrigin(req, origin)) return next(forbidden("This origin is not allowed"));

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, X-Request-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }

  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
}

/**
 * 为除 GET/HEAD/OPTIONS 外的浏览器请求校验会话 CSRF 令牌和路径来源。
 * @param {import("express").Request} req 已由 authenticate 填充 req.auth 的请求。
 * @param {import("express").Response} res 当前 HTTP 响应，当前实现不直接写入响应。
 * @param {import("express").NextFunction} next 继续路由或传递拒绝错误的 Express 回调。
 * @returns {void} CSRF 校验通过或请求无需校验时继续。
 * @throws {import("../lib/http-error").HttpError} 来源或 X-CSRF-Token 无效时通过 next 传递 403。
 */
function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!req.auth) return next();
  if (!isAllowedOrigin(req, req.get("origin"))) return next(forbidden("This origin is not allowed"));
  if (req.get("x-csrf-token") !== req.auth.csrf) {
    return next(forbidden("The CSRF token is missing or invalid"));
  }
  return next();
}

module.exports = { originGuard, csrfGuard };
