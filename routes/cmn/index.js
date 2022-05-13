const express = require("express");
const cmnRouter = express.Router();
const cmnController = _require("controller/cmn/index");

/* 分页列表 */
cmnRouter.get("/findAll", cmnController.findAll);

/* 删除 */
cmnRouter.delete("/removeById", cmnController.removeById);

module.exports = cmnRouter;
