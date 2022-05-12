const express = require("express");
const companyRouter = express.Router();
const companyController = _require("controller/company/index");

/* 公司列表 */
companyRouter.get("/findList", companyController.findList);

module.exports = companyRouter;
