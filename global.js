const path = require("path");
const Parse = require("parse/node");
const multer = require('multer')
global._require = (filePath) => {
  return require(path.join(process.cwd(), filePath));
};
const date = new Date()
const year = date.getFullYear()
const month = date.getMonth();
const day = date.getDate();
Parse.initialize("shumian0511");
Parse.masterKey = "shumian100329";
Parse.serverURL = "http://localhost:3000/parse";
global.Parse = Parse
global.todayStatic = 'resources/' + year + '/' + month + '/' + day + '/'
global.upload = multer({ dest: todayStatic })
