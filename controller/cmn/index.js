const ResponseJson = _require("ResponseJson");
const Query = _require("query");
const moment = require("moment");
const Parse = require("parse/node");
const cmnController = {
  findAll: async (req, res) => {
    const { className, companyId, pageSize, pageNum, name = "" } = req.query;
    const table = new Parse.Query(className);
    if (name && name.length) {
      table.contains("name", name);
    }
    table.equalTo("isDelete", false);
    table.equalTo("company", companyId);
    const total = await table.count();
    table.ascending("createdAt");
    table.limit(Number(pageSize) || 10);
    table.skip(Number(pageSize * (pageNum - 1)) || 0);
    const result = (await table.find()).map((item) => {
      item = item.toJSON();
      item.createdAt = moment(new Date(item.createdAt)).format(
        "YYYY-MM-DD HH:mm:ss"
      );
      return item;
    });

    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData({ count: total, curPage: pageNum || 1, list: result })
    );
  },

  findList: async (req, res) => {
    const { className, companyId, name = "" } = req.query;
    const table = new Parse.Query(className);
    if (name && name.length) {
      table.contains("name", name);
    }
    table.ascending("createdAt");
    table.equalTo("isDelete", false);
    table.equalTo("company", companyId);
    const result = (await table.find()).map((item) => {
      item = item.toJSON();
      item.createdAt = moment(new Date(item.createdAt)).format(
        "YYYY-MM-DD HH:mm:ss"
      );
      return item;
    });

    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },

  removeById: async (req, res) => {
    const { objectId, companyId, className } = req.body;
    const table = new Parse.Query(className);
    table.equalTo("objectId", objectId);
    table.equalTo("company", companyId);
    const row = await table.first();
    if (row && row.id) {
      row.set("isDelete", true);
      const result = await row.save();
      if (result && result.id) {
        res.json(
          new ResponseJson().setCode(200).setMessage("删除成功").setData(result)
        );
      } else {
        throw {
          code: 500,
          msg: "删除失败",
        };
      }
    } else {
      throw {
        code: 401,
        msg: "模块不存在",
      };
    }
  },
};

module.exports = cmnController;
