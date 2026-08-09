Promise.resolve()
  .then(() => require("./main").start())
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
