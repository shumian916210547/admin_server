require("./global");
require("express-async-errors");
const http = require("http");
const moment = require("moment");
const express = require("express");
const connection = require("./pgsql");
const router = require("./routes/index");
const ResponseJson = require("./ResponseJson");
const ParseDashboard = require("parse-dashboard");
const ParseServer = require("parse-server").ParseServer;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.all("*", (req, res, next) => {
  let params = req.method == "GET" ? req.query : req.body;
  const time = moment(new Date()).format("YYYY-MM-DD HH:mm:ss");
  req._startTime = new Date().getMilliseconds();

  let calResponseTime = function () {
    let now = new Date().getMilliseconds();
    let deltaTime = Math.abs(now - req._startTime);
    let ip =
      req.headers["x-real-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddres ||
      req.socket.remoteAddress ||
      "";
    if (ip.split(",").length > 0) {
      ip = ip.split(",")[0];
    }
    console.log("请求路径：" + req.originalUrl, " 耗时：" + deltaTime + "ms");
  };

  if (req.method != "OPTIONS") {
    res.once("finish", calResponseTime);
    /* res.once('close', calResponseTime); */
  }

  if (req.path !== "/" && !req.path.includes(".")) {
    res.set({
      "Access-Control-Allow-Credentials": true,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "X-Requested-With,Content-Type,Authorization",
      "Access-Control-Allow-Methods": "PUT,POST,GET,DELETE,OPTIONS",
      "X-Powered-By": " 3.2.1",
      /*       "Content-Type": "application/json;charset=utf-8", */
    });
  }

  /* if (
    process.env.NODE_ENV == "production" &&
    req.path.indexOf("/dashboard") > -1
  ) {
    res.status(404).end();
  } */

  req.method === "OPTIONS" ? res.status(204).end() : next();
});

/* parse-server */
app.use(
  "/parse",
  new ParseServer({
    databaseURI: `postgres://postgres:100329@localhost:5432/postgres`,
    cloud: "./cloud.js",
    appId: "shumian0511",
    masterKey: "shumian100329",
  })
);

/* parse-dashboard */
app.use(
  "/dashboard",
  new ParseDashboard(
    {
      apps: [
        {
          serverURL: process.env.ParseHost,
          appId: "shumian0511",
          masterKey: "shumian100329",
          appName: process.env.npm_package_name,
        },
      ],
    },
    { allowInsecureHTTP: false }
  )
);

app.use(router);

/* 捕获错误 */
app.use((err, req, res, next) => {
  const url = req.path;
  const time = moment(new Date()).format("YYYY-MM-DD HH:mm:ss");
  console.log(
    "请求发生错误时间：" + time + " 请求路径：" + req.path,
    " 请求方法：" + req.method
  );
  console.log(err);
  res.json(
    new ResponseJson()
      .setCode(err.code)
      .setMessage(err.msg || err || err.message)
  );
});

/* http */
const server = http.createServer(app);
server.listen(3000, async () => {
  console.log("当前环境:", process.env.NODE_ENV);
  connection.clientDataBase();
  console.log("服务启动成功:", process.env.ServerHost);
  app.listen(1337);
});

module.exports = app;
