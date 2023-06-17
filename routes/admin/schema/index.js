const express = require("express");
const schemaRouter = express.Router();
const schemaController = _require("controller/schema/index");

/* schema列表 */
schemaRouter.get("/findList", jwt.verify, schemaController.findList);

/* 新建Schema */
schemaRouter.post("/insertSchema", jwt.verify, schemaController.insertSchema);

/* 更新 */
schemaRouter.put("/updateById", jwt.verify, schemaController.updateById);

/* 删除字段 */
schemaRouter.delete("/removeFields", jwt.verify, schemaController.removeFields);

module.exports = schemaRouter;
