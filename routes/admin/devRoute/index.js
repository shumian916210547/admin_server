const express = require("express");
const devRouteRouter = express.Router();
const devRouteController = _require("controller/devRoute/index");

/* 路由列表 */
devRouteRouter.get("/findAll", jwt.verify, devRouteController.findAll);

/* 所有路由列表 */
devRouteRouter.get("/findList", jwt.verify, devRouteController.findList);

/* 查询路由 */
devRouteRouter.get("/findById", jwt.verify, devRouteController.findById);

/* 新建路由 */
devRouteRouter.post("/insertDevRoute", jwt.verify, devRouteController.insertDevRoute);

/* 修改路由信息 */
devRouteRouter.put("/updateById", jwt.verify, devRouteController.updateById);

/* 删除路由 */
devRouteRouter.delete("/removeById", jwt.verify, devRouteController.removeById);

/* 字段修改后 路由option修改 */
devRouteRouter.put("/updateOption", jwt.verify, devRouteController.updateOption);

module.exports = devRouteRouter;
