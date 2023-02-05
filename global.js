const path = require("path");
const Parse = require("parse/node");

Parse.initialize("shumian0511");
Parse.masterKey = "shumian100329";
Parse.serverURL = "http://localhost:3000/parse";
global._require = (filePath) => {
  return require(path.join(process.cwd(), filePath));
};
global.Parse = (filePath) => {
  return Parse;
};
