require("./global");
require("express-async-errors");
const http = require("http");
const moment = require("moment");
const express = require("express");
const router = require("./routes/index");
const ResponseJson = require("./ResponseJson");
const app = express();
app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

const RequestInfo = require("./Request.Info")
const Headers = require("./Request.headers")
app.all("*", (req, res, next) => {
  RequestInfo(req, res)
  if (req.path !== "/" && !req.path.includes(".")) {
    res.set(Headers);
  }
  req.method === "OPTIONS" ? res.status(204).end() : next();
});

const ParseConfig = require("./Parse.Config")
ParseConfig.forEach((item) => {
  app.use(item.path, item.component)
})

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
  console.log("服务启动成功:", process.env.ServerHost);
  app.listen(1337);
});

module.exports = app;