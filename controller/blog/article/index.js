const ResponseJson = _require("ResponseJson")
const Query = _require("query")
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
  }
}

module.exports = articleController