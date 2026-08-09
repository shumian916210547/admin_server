const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { config } = require("../config/env");
const { unauthorized } = require("../lib/http-error");

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, entry) => {
    const separator = entry.indexOf("=");
    if (separator < 0) return cookies;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

/**
 * 为已通过验证的用户创建带 CSRF 令牌的持久化会话；Cookie 默认采用 30 天滑动有效期。
 * @param {string} userId Parse _User 的 objectId，必须来自服务端认证流程。
 * @returns {{token: string, csrfToken: string, sessionId: string}} HttpOnly Cookie 的 JWT、前端写操作所需 CSRF 令牌和仅供服务端审计关联的会话 ID。
 */
function createSession(userId) {
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const sessionId = crypto.randomUUID();
  const token = signSessionToken({ sub: userId, csrf: csrfToken, jti: sessionId });

  return { token, csrfToken, sessionId };
}

/**
 * 使用既有会话声明签发新的 JWT，使有效操作可以把会话过期时间滑动到当前时间之后。
 * @param {{sub: string, csrf: string, jti: string}} session 已通过签名校验的会话声明。
 * @returns {string} 继承用户、CSRF 和稳定会话 ID 的新 JWT；不改变身份边界。
 * @throws {Error} JWT 密钥或会话声明不符合签发要求时抛出。
 */
function signSessionToken(session) {
  return jwt.sign(
    {
      sub: session.sub,
      csrf: session.csrf,
      jti: session.jti,
    },
    config.auth.jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: config.auth.ttlSeconds,
      issuer: "shumian-admin-api",
      audience: "shumian-admin-web",
    }
  );
}

/**
 * 为已验证的会话重新生成 Cookie，保持 jti 稳定以便登录活动统计继续关联同一会话。
 * @param {import("express").Response} res Express 响应对象，用于写入 Set-Cookie。
 * @param {{sub: string, csrf: string, jti: string}} session 已通过 readSession 校验的会话声明。
 * @returns {void} 写入新的 HttpOnly Cookie；不返回 Token 给浏览器脚本。
 */
function renewSessionCookie(res, session) {
  setSessionCookie(res, signSessionToken(session));
}

function readSession(req) {
  const token = parseCookies(req.headers.cookie)[config.auth.cookieName];
  if (!token) throw unauthorized();

  try {
    return jwt.verify(token, config.auth.jwtSecret, {
      algorithms: ["HS256"],
      issuer: "shumian-admin-api",
      audience: "shumian-admin-web",
    });
  } catch {
    throw unauthorized("Your session has expired or is invalid");
  }
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    maxAge: config.auth.ttlSeconds * 1000,
    path: "/",
  };
}

function setSessionCookie(res, token) {
  res.cookie(config.auth.cookieName, token, sessionCookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(config.auth.cookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/",
  });
}

module.exports = {
  createSession,
  readSession,
  renewSessionCookie,
  setSessionCookie,
  clearSessionCookie,
};
