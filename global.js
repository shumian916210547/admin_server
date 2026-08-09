const path = require("path");
const multer = require("multer");
const { config } = require("./config/env");
const { initializeParse } = require("./services/parse-runtime");
const jwt = require("./jwt");

const Parse = initializeParse();
const date = new Date();

global.Parse = Parse;
global.jwt = jwt;
global._require = (filePath) => require(path.resolve(process.cwd(), filePath));
global.year = date.getUTCFullYear();
global.month = date.getUTCMonth() + 1;
global.day = date.getUTCDate();
global.static = config.upload.storageDir;
global.today = `${global.year}/${global.month}/${global.day}`;
// Kept only for opt-in legacy integrations. The public application uses the
// authenticated /api/files endpoint with validation and size limits instead.
global.upload = multer({ dest: path.join(config.upload.storageDir, ".legacy-tmp") });
global.verify = (params) => {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") {
      throw new Error(`${key} is required`);
    }
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
      throw new Error(`${key} is required`);
    }
  }
};
