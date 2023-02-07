const express = require("express");
const parseRouter = express.Router();
const ParseServer = require("parse-server").ParseServer;
const databaseConfig = _require("databaseConfig");

const parse_server = new ParseServer({
  databaseURI: `postgres://postgres:100329@localhost:5432/postgres`,
  cloud: "./cloud.js",
  appId: "shumian0511",
  masterKey: "shumian100329",
});
parseRouter.use(parse_server);

module.exports = parseRouter;
