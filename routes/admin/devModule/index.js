const express = require("express");
const devModuleRouter = express.Router();
const devModuleController = _require("controller/devModule/index");

/* 模块列表 */
devModuleRouter.get("/findAll", jwt.verify, devModuleController.findAll);

/* 所有模块列表 */
devModuleRouter.get("/findList", jwt.verify, devModuleController.findList);

/* 查询模块 */
devModuleRouter.get("/findById", jwt.verify, devModuleController.findById);

/* 新建模块 */
devModuleRouter.post("/insertDevModule", jwt.verify, devModuleController.insertDevModule);

/* 修改模块信息 */
devModuleRouter.put("/updateById", jwt.verify, devModuleController.updateById);

/* 删除模块 */
devModuleRouter.delete("/removeById", jwt.verify, devModuleController.removeById);

module.exports = devModuleRouter;
