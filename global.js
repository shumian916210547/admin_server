const path = require("path");
const Parse = require("parse/node");

global._require = (filePath) => {
  return require(path.join(process.cwd(), filePath));
};

global.PostgresHOST = () => {
  if (process.env.NODE_ENV == "production") {
    return "postgres.shumian.top";
  } else {
    return "localhost";
  }
};

global.ParseHOST = () => {
  if (process.env.NODE_ENV == "production") {
    return "https://api.shumian.top/parse";
  } else {
    return "http://localhost:3000/parse";
  }
};

global.ServerHOST = () => {
  if (process.env.NODE_ENV == "production") {
    return "https://api.shumian.top";
  } else {
    return "http://localhost:3000";
  }
};

Parse.initialize("shumian0511");
Parse.masterKey = "shumian100329";
Parse.serverURL = ParseHOST;
global.Parse = () => {
  return Parse;
};
