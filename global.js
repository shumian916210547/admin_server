const path = require("path");
const fs = require("fs");
const Parse = require("parse/node");
let serverURL = "http://localhost:3000/parse";

if (process.env.NODE_ENV == "production") {
  serverURL = "https://api.shumian.top/parse";
}

Parse.initialize("shumian0511");
Parse.masterKey = "shumian100329";
Parse.serverURL = serverURL;
global._require = (filePath) => {
  return require(path.join(process.cwd(), filePath));
};
global.Parse = (filePath) => {
  return Parse;
};
