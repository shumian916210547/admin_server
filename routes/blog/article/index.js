const express = require("express");
const articleRouter = express.Router();
const articleController = _require("controller/article/index");

/* 文章列表（分页） */
articleRouter.get("/findAll", articleController.findAll);

/* 文章增加热度(1) */
articleRouter.put("/updateHot", articleController.updateHot);

/* 修改文章 */
articleRouter.put("/updateById", articleController.updateById);

/* 增加文章 */
articleRouter.post("/insertArticle", articleController.insertArticle);

/* 获取热门文章（热度前十条） */
articleRouter.get("/findHotArticle", articleController.findHotArticle);

module.exports = articleRouter;
