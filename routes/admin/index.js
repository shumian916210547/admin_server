const express = require("express");
const blogRouter = express.Router();

const fs = require("fs")
const path = require("path")
fs.readdir(__dirname, function (err, files) {
  files.forEach(item => {
    if (fs.lstatSync(path.join(__dirname, item)).isDirectory()) {
      blogRouter.use('/' + item, require(path.join(__dirname, item)))
    }
  })
})

module.exports = blogRouter;