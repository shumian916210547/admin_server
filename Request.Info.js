const moment = require("moment");
module.exports = (req, res) => {
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
  }
}