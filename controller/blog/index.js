const fs = require("fs")
const path = require("path")

const blog = {}
fs.readdirSync(__dirname).forEach(item => {
  if (fs.lstatSync(path.join(__dirname, item)).isDirectory()) {
    blog[item + "Controller"] = require(path.join(__dirname, item))
  }
})

module.exports = blog