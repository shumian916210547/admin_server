const ParseServer = require("parse-server").ParseServer;
const ParseDashboard = require("parse-dashboard");
const Parse = require("parse/node");
const express = require("express");
const http = require("http");
const connection = require("./pgsql");
const app = express();
const databaseConfig = require("./databaseConfig");

let serverURL = "http://localhost:3000/parse";

if (process.env.NODE_ENV == "development") {
  serverURL = "http://localhost:3000/parse";
}

if (process.env.NODE_ENV == "production") {
  serverURL = "https://api.shumian.top/parse";
}

app.use(
  "/parse",
  new ParseServer({
    databaseURI: `postgres://${databaseConfig.host}:5432/postgres`,
    cloud: "./cloud.js",
    appId: "shumian0511",
    masterKey: "shumian100329",
  })
);

app.use(
  "/dashboard",
  new ParseDashboard(
    {
      apps: [
        {
          serverURL,
          appId: "shumian0511",
          masterKey: "shumian100329",
          appName: process.env.npm_package_name,
        },
      ],
    },
    { allowInsecureHTTP: false }
  )
);

/* http */
const server = http.createServer(app);

server.listen(3000, async () => {
  connection.connect();
  console.log("服务启动成功 http://localhost:3000");
  app.listen(1337, () => {
    Parse.initialize("shumian0511");
    Parse.masterKey = "shumian100329";
    Parse.serverURL = serverURL;
  });
  console.log("Current Service Version: " + process.env.npm_package_version);
});
