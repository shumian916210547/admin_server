const express = require("express");
const devRouteRouter = express.Router();
const devRouteController = _require("controller/devRoute/index");

/* 路由列表 */
devRouteRouter.get("/findAll", devRouteController.findAll);

/* 查询路由 */
devRouteRouter.get("/findById", devRouteController.findById);

/* 新建路由 */
devRouteRouter.post("/insertDevRoute", devRouteController.insertDevRoute);

/* 修改路由信息 */
devRouteRouter.put("/updateById", devRouteController.updateById);

/* 删除路由 */
devRouteRouter.delete("/removeById", devRouteController.removeById);

module.exports = devRouteRouter;
