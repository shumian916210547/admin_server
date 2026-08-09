const { config } = require("../config/env");
const { forbidden } = require("../lib/http-error");

function isAllowedOrigin(origin) {
  return !origin || config.allowedOrigins.includes(origin);
}

function originGuard(req, res, next) {
  const origin = req.get("origin");
  if (!isAllowedOrigin(origin)) return next(forbidden("This origin is not allowed"));

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

function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!req.auth) return next();
  if (!isAllowedOrigin(req.get("origin"))) return next(forbidden("This origin is not allowed"));
  if (req.get("x-csrf-token") !== req.auth.csrf) {
    return next(forbidden("The CSRF token is missing or invalid"));
  }
  return next();
}

module.exports = { originGuard, csrfGuard };
