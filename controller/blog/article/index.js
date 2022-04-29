const ResponseJson = _require("ResponseJson")
const Query = _require("query")
const { async } = require("parse/lib/browser/Storage")
const Parse = require("parse/node")
const articleController = {
  insertArticle: async (req, res) => { },
  findAll: async (req, res) => {
    const { pageSize, pageNum } = req.query
    const article = new Parse.Query("article");
    const total = await article.count();
    article.limit(pageSize || 10);
    article.skip(pageSize * pageNum || 0)
    const result = await article.find();
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData({ count: total, curPage: pageNum || 1, list: result })
    );
  },
  updateHot: async (req, res) => {
    const { articleId } = req.body;
    if (!articleId) {
      throw {
        code: 401,
        msg: 'articleId不能为空'
      }
    }
    const article = new Parse.Query("article");
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
        msg: '文章不存在'
      }
    }
  },
  updateById: async (req, res) => {
    const { articleId, content, title } = req.body;
    if (!articleId) {
      throw {
        code: 401,
        msg: 'articleId不能为空'
      }
    }
    const article = new Parse.Query("article");
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
        msg: '文章不存在'
      }
    }
  }
}


module.exports = articleController