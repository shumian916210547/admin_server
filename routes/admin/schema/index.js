const express = require("express");
const schemaRouter = express.Router();
const schemaController = _require("controller/schema/index");

/* schema列表 */
schemaRouter.get("/findList", schemaController.findList);

/* 新建Schema */
schemaRouter.post("/insertSchema", schemaController.insertSchema);

/* 更新 */
schemaRouter.put("/updateById", schemaController.updateById);

/* 删除字段 */
schemaRouter.delete("/removeFields", schemaController.removeFields);

module.exports = schemaRouter;
