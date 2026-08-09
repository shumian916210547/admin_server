const { config } = require("./config/env");

const databaseUrl = new URL(config.parse.databaseUri);

module.exports = {
  connectionString: config.parse.databaseUri,
  user: decodeURIComponent(databaseUrl.username),
  database: databaseUrl.pathname.replace(/^\//, ""),
  password: decodeURIComponent(databaseUrl.password),
  port: Number(databaseUrl.port || 5432),
  host: databaseUrl.hostname,
};
