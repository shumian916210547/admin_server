const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

/* router.use((req, res, next) => {
  if (req.originalUrl.indexOf("/blog/") > -1) {
    req.body['companyId'] = 'QbN9Lq7W9v'
  }

  if (req.originalUrl.indexOf("/admin/") > -1) {
    req.body['companyId'] = 'D9BPrTCZA1'
  }
  next()
}) */

fs.readdir(__dirname, function (err, files) {
  files.forEach((item) => {
    if (fs.lstatSync(path.join(__dirname, item)).isDirectory()) {
      router.use("/" + item, require(path.join(__dirname, item)));
    }
  });
});

module.exports = router;
