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

/* 更新 */
cmnRouter.get("/getClientIP", cmnController.getClientIP);

/* 上传文件 */
cmnRouter.post("/uploadFile", upload.single('file'), cmnController.uploadFile);

/* 读取文件 */
cmnRouter.get("/readFile/resources/:year/:month/:day/:filename", cmnController.readFile);

module.exports = cmnRouter;
