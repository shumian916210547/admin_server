const fs = require("fs")
const path = require("path")

const controller = {}
fs.readdirSync(__dirname).forEach(item => {
  if (fs.lstatSync(path.join(__dirname, item)).isDirectory()) {
    controller[item] = require(path.join(__dirname, item))
  }
})

module.exports = controller