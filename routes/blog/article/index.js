const express = require("express");
const articleRouter = express.Router();
const articleController = _require("controller/blog/article/index")

/* 文章列表（分页） */
articleRouter.get("/findAll", articleController.findAll)

module.exports = articleRouter;