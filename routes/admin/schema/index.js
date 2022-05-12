const express = require("express");
const schemaRouter = express.Router();
const schemaController = _require("controller/schema/index");

/* schema列表 */
schemaRouter.get("/findList", schemaController.findList);

module.exports = schemaRouter;
