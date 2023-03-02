const path = require("path");
const Parse = require("parse/node");
const multer = require("multer");
global._require = (filePath) => {
  return require(path.join(process.cwd(), filePath));
};
const date = new Date();
const year = date.getFullYear();
const month = date.getMonth();
const day = date.getDate();
Parse.initialize("shumian0511");
Parse.masterKey = "shumian100329";
Parse.serverURL = "http://localhost:3000/parse";
global.Parse = Parse;
global.todayStatic = "resources/" + year + "/" + (month + 1) + "/" + day + "/";
global.upload = multer({ dest: todayStatic });
global.verify = (params) => {
  for (const key of Object.keys({ ...params })) {
    if (typeof (params[key]) === 'object') {
      if (Object.keys(params[key]).length === 0) {
        throw (key + '不能为空')
      }
    } else if (params[key] == undefined || !params[key]) {
      throw (key + '不能为空')
    }
  }
}
