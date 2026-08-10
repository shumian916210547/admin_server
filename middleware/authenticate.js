const { readSession, renewSessionCookie } = require("../services/auth.service");
const { getAuthContext } = require("../services/parse-data.service");
const { validateAndTouchAdminSession } = require("../services/admin-session.service");

/**
 * 校验 HttpOnly 会话、加载服务端认证上下文，并为每次有效请求滑动续期 Cookie。
 * @param {import("express").Request} req 请求对象；Cookie 是唯一的会话凭据来源。
 * @param {import("express").Response} res 响应对象；成功认证后写入新的会话过期时间。
 * @param {import("express").NextFunction} next Express 后续中间件；认证失败时接收统一错误。
 * @returns {Promise<void>} 认证上下文写入 req.auth 后继续处理；失败时不放宽租户边界。
 * @throws {Error} Cookie 缺失、JWT 无效、账号不可用或企业上下文不存在时交给错误中间件。
 */
async function authenticate(req, res, next) {
  try {
    const session = readSession(req);
    const context = await getAuthContext(session.sub);
    await validateAndTouchAdminSession(session, context, req);
    req.auth = { ...context, csrf: session.csrf, sessionId: session.jti };
    renewSessionCookie(res, session);
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { authenticate };
