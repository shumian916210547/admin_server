const express = require('express');
require("express-async-errors")
require("./global")
const app = express();
const http = require("http");
const connection = require("./pgsql")
const ParseServer = require('parse-server').ParseServer;
const ParseDashboard = require('parse-dashboard');
const router = require("./routes/index")
const utils = require("./utils")
const moment = require('moment')
const ResponseJson = require("./ResponseJson");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.all("*", (req, res, next) => {
  let params = req.method == 'GET' ? req.query : req.body
  const time = moment(new Date()).format("YYYY-MM-DD HH:mm:ss")
  req._startTime = new Date().getMilliseconds()

  let calResponseTime = function () {
    let now = new Date().getMilliseconds();
    let deltaTime = Math.abs(now - req._startTime);
    let ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddres || req.socket.remoteAddress || '';
    if (ip.split(',').length > 0) {
      ip = (ip.split(',')[0]);
    }
    console.log("请求路径：" + req.originalUrl, ' 耗时：' + deltaTime + 'ms')
  }

  if (req.method != 'OPTIONS') {
    res.once('finish', calResponseTime);
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
      "Content-Type": "application/json; charset=utf-8",
    });
  }
  req.method === "OPTIONS" ? res.status(204).end() : next();
});

app.use(router)

/* 捕获错误 */
app.use((err, req, res, next) => {
  const url = req.path
  const time = moment(new Date).format("YYYY-MM-DD HH:mm:ss")
  console.log("请求发生错误时间：" + time + " 请求路径：" + req.path, " 请求方法：" + req.method)
  console.log(err);
  res.json(new ResponseJson().setCode(err.code).setMessage(err.msg || err));
})

app.use('/parse', new ParseServer({
  databaseURI: 'postgres://114.215.210.204:5432/postgres',
  cloud: './cloud.js',
  appId: 'shumian0511',
  masterKey: 'shumian100329',
}));

app.use("/dashboard", new ParseDashboard({
  "apps": [
    {
      "serverURL": "http://localhost:3000/parse",
      "appId": "shumian0511",
      "masterKey": "shumian100329",
      "appName": process.env.npm_package_name
    }
  ]
}, { allowInsecureHTTP: false }))

const server = http.createServer(app);

server.listen(3000, () => {
  console.log('服务启动成功 http://localhost:3000');
  app.listen(1337, () => {
    Parse.initialize("shumian0511")
    Parse.serverURL = "http://localhost:3000/parse"
  })
  console.log("Current Service Version: " + process.env.npm_package_version);
  connection.connect((err) => {
    if (!err) {
      console.log('数据库连接成功')
    } else {
      console.log(err);
    }
  })
});

module.exports = app;
