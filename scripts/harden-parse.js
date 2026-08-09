"use strict";

const { hardenAllClassPermissions } = require("../services/parse-data.service");

async function main() {
  const classes = await hardenAllClassPermissions();
  console.log(JSON.stringify({ hardenedClasses: classes, count: classes.length }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
