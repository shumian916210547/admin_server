const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const { config } = require("./config/env");
const apiRouter = require("./routes/api");
const { HttpError, notFound } = require("./lib/http-error");
const logger = require("./lib/logger");
const { requestContext } = require("./middleware/request-context");
const { originGuard } = require("./middleware/origin");

function createPublicApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-origin" } }));
  app.use(requestContext);
  app.use(originGuard);
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.get("/healthz", (req, res) => res.json({ status: "ok", requestId: req.requestId }));
  app.use("/api", apiRouter);
  app.use((req, res, next) => next(notFound()));
  app.use((error, req, res, next) => {
    const uploadError = error instanceof multer.MulterError;
    const status = error instanceof HttpError ? error.status : uploadError ? 400 : 500;
    const code = error instanceof HttpError ? error.code : uploadError ? "UPLOAD_ERROR" : "INTERNAL_ERROR";
    const message = error instanceof HttpError || uploadError ? error.message : "An unexpected error occurred";
    logger.error("http.error", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl?.split("?")[0],
      status,
      code,
      error: error.message,
      stack: config.isProduction ? undefined : error.stack,
    });
    res.status(status).json({ error: { code, message }, requestId: req.requestId });
  });
  return app;
}

module.exports = { createPublicApp };
