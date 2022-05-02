const express = require("express");
const devModuleRouter = express.Router();
const devModuleController = _require("controller/admin/devModule/index")

/* 模块列表 */
devModuleRouter.get("/findAll", devModuleController.findAll)

/* 新建模块 */
devModuleRouter.post("/insertDevModule", devModuleController.insertDevModule)

module.exports = devModuleRouter;