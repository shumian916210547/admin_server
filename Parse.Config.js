const ParseDashboard = require("parse-dashboard");
const ParseServer = require("parse-server").ParseServer;

module.exports = [
  {
    path: "/parse",
    component: new ParseServer({
      databaseURI: `postgres://postgres:100329@localhost:5432/postgres`,
      cloud: "./cloud.js",
      appId: "shumian0511",
      masterKey: "shumian100329",
      directAccess: false,
      enforcePrivateUsers: false
    })
  },
  {
    path: "/dashboard",
    component: new ParseDashboard({
      apps: [{
        serverURL: process.env.ParseHost || "http://localhost:3000/parse",
        appId: "shumian0511",
        masterKey: "shumian100329",
        appName: process.env.npm_package_name,
        supportedPushLocales: ["cn", "en", "ru", "fr"]
      }],
    }, {
      allowInsecureHTTP: false
    })
  },
]