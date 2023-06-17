const express = require("express");
const cmnRouter = express.Router();
const cmnController = _require("controller/cmn/index");

/* 分页列表 */
cmnRouter.get("/findAll", jwt.verify, cmnController.findAll);

/* 所有列表 */
cmnRouter.get("/findList", jwt.verify, cmnController.findList);

/* 删除 */
cmnRouter.delete("/removeById", jwt.verify, cmnController.removeById);

/* 插入 */
cmnRouter.post("/insert", jwt.verify, cmnController.insert);

/* 批量插入 */
cmnRouter.post("/insertList", jwt.verify, cmnController.insertList);

/* 更新 */
cmnRouter.put("/updateById", jwt.verify, cmnController.updateById);

/* 获取ip */
cmnRouter.get("/getClientIP", cmnController.getClientIP);

/* 上传文件 */
cmnRouter.post("/uploadFile", upload.single('file'), cmnController.uploadFile);

/* 读取文件 */
cmnRouter.get("/readFile/resources/:uid/:year/:month/:day/:filename", cmnController.readFile);

module.exports = cmnRouter;