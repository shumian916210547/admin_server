const http = require("http");
const express = require("express");
const { config } = require("./config/env");
const logger = require("./lib/logger");
const { createPublicApp } = require("./app-factory");
const { createParseServer } = require("./services/parse-runtime");

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function start() {
  const parseServer = createParseServer();
  if (typeof parseServer.start === "function") await parseServer.start();

  const internalApp = express();
  internalApp.disable("x-powered-by");
  internalApp.use("/parse", parseServer.app || parseServer);

  const internalServer = http.createServer(internalApp);
  await listen(internalServer, config.parse.internalPort, config.parse.internalHost);

  const publicApp = createPublicApp();
  const publicServer = http.createServer(publicApp);
  await listen(publicServer, config.port, "0.0.0.0");

  logger.info("server.started", {
    environment: config.environment,
    publicPort: config.port,
    parseInternalHost: config.parse.internalHost,
    parseInternalPort: config.parse.internalPort,
    dashboardEnabled: false,
  });

  return { publicApp, publicServer, internalApp, internalServer };
}

module.exports = { start, createPublicApp };
