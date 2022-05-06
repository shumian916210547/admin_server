const ResponseJson = _require("ResponseJson");
const Query = _require("query");
const Parse = require("parse/node");
const articleController = {
  insertArticle: async (req, res) => {
    const { content, title, companyId } = req.body;
    if (!content || !title) {
      throw {
        code: 401,
        msg: "content, title不能为空",
      };
    }

    const Article = Parse.Object.extend("Article");
    const article = new Article();
    article.set("title", title);
    article.set("content", content);
    article.set("company", {
      __type: "Pointer",
      className: "Company",
      objectId: companyId,
    });

    const result = await article.save();
    if (result && result.id) {
      res.json(
        new ResponseJson().setCode(200).setMessage("添加成功").setData(result)
      );
    } else {
      throw {
        code: 500,
        msg: "保存失败",
      };
    }
  },
  findAll: async (req, res) => {
    const { companyId } = req.body
    const { pageSize, pageNum } = req.query;
    const article = new Parse.Query("Article");
    article.equalTo("company", companyId)
    const total = await article.count();
    article.limit(Number(pageSize) || 10);
    article.skip(Number(pageSize * (pageNum - 1)) || 0);
    const result = await article.find();
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData({ count: total, curPage: pageNum || 1, list: result })
    );
  },
  findHotArticle: async (req, res) => {
    const { companyId } = req.body
    const article = new Parse.Query("Article");
    article.equalTo("company", companyId)
    article.descending("hits");
    article.limit(10);
    const result = await article.find();
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData(result)
    );
  },
  updateHot: async (req, res) => {
    const { articleId } = req.body;
    if (!articleId) {
      throw {
        code: 401,
        msg: "articleId不能为空",
      };
    }
    const article = new Parse.Query("Article");
    article.equalTo("objectId", articleId);
    const r = await article.first();
    if (r && r.id) {
      r.set("hits", r.get("hits") + 1);
      const result = await r.save();
      res.json(
        new ResponseJson().setCode(200).setMessage("更新成功").setData(result)
      );
    } else {
      throw {
        code: 404,
        msg: "文章不存在",
      };
    }
  },
  updateById: async (req, res) => {
    const { articleId, content, title } = req.body;
    if (!articleId) {
      throw {
        code: 401,
        msg: "articleId不能为空",
      };
    }
    const article = new Parse.Query("Article");
    article.equalTo("objectId", articleId);
    const r = await article.first();
    if (r && r.id) {
      r.set("title", title || r.get("title"));
      r.set("content", content || r.get("content"));
      const result = await r.save();
      res.json(
        new ResponseJson().setCode(200).setMessage("更新成功").setData(result)
      );
    } else {
      throw {
        code: 404,
        msg: "文章不存在",
      };
    }
  },
};

module.exports = articleController;
