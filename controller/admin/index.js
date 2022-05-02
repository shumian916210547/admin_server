const fs = require("fs")
const path = require("path")

const admin = {}
fs.readdirSync(__dirname).forEach(item => {
  if (fs.lstatSync(path.join(__dirname, item)).isDirectory()) {
    admin[item + "Controller"] = require(path.join(__dirname, item))
  }
})

admin.exports = admin