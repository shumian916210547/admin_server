const express = require("express");
const articleRouter = express.Router();
const articleController = _require("controller/blog/article/index")

/* 文章列表（分页） */
articleRouter.get("/findAll", articleController.findAll)

/* 文章增加热度(1) */
articleRouter.put("/updateHot", articleController.updateHot)

/* 修改文章 */
articleRouter.put("/updateById", articleController.updateById)

module.exports = articleRouter;