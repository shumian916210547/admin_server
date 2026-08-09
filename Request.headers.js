const { config } = require("./config/env");

module.exports = {
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Origin": config.publicOrigin,
  "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, X-Request-Id",
  "Access-Control-Allow-Methods": "PUT,POST,GET,DELETE,OPTIONS",
};
