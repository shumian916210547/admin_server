const path = require("path")
global._require = (filePath) => {
  return require(path.join(process.cwd(), filePath))
}