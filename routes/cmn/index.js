const express = require("express");
const cmnRouter = express.Router();
const cmnController = _require("controller/cmn/index");

/* 分页列表 */
cmnRouter.get("/findAll", cmnController.findAll);

/* 所有列表 */
cmnRouter.get("/findList", cmnController.findList);

/* 删除 */
cmnRouter.delete("/removeById", cmnController.removeById);

/* 插入 */
cmnRouter.post("/insert", cmnController.insert);

/* 批量插入 */
cmnRouter.post("/insertList", cmnController.insertList);

/* 更新 */
cmnRouter.put("/updateById", cmnController.updateById);

module.exports = cmnRouter;
