const crypto = require("crypto");
const logger = require("../lib/logger");

function requestContext(req, res, next) {
  req.requestId = req.get("x-request-id") || crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  res.setHeader("x-request-id", req.requestId);
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info("http.request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
    });
  });
  next();
}

module.exports = { requestContext };
