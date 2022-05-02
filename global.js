const path = require("path")
const fs = require("fs");

global._require = (filePath) => {
  return require(path.join(process.cwd(), filePath))
}