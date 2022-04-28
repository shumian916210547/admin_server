const express = require("express");
const router = express.Router();

const fs = require("fs")
const path = require("path")
fs.readdir(__dirname, function (err, files) {
  files.forEach(item => {
    if (fs.lstatSync(path.join(__dirname, item)).isDirectory()) {
      router.use('/' + item, require(path.join(__dirname, item)))
    }
  })
})

module.exports = router;
