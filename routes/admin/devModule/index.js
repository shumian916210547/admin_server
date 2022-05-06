const express = require("express");
const devModuleRouter = express.Router();
const devModuleController = _require("controller/devModule/index");

/* 模块列表 */
devModuleRouter.get("/findAll", devModuleController.findAll);

/* 查询模块 */
devModuleRouter.get("/findById", devModuleController.findById);

/* 新建模块 */
devModuleRouter.post("/insertDevModule", devModuleController.insertDevModule);

/* 修改模块信息 */
devModuleRouter.put("/updateById", devModuleController.updateById);

/* 删除模块 */
devModuleRouter.delete("/removeById", devModuleController.removeById);

module.exports = devModuleRouter;
