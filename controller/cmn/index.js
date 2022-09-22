const ResponseJson = _require("ResponseJson");
const Query = _require("query");
const moment = require("moment");
/* const Parse = require("parse/node"); */
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

  insert: async (req, res) => {
    const { params, className, companyId } = req.body;
    if (!className) {
      throw {
        code: 401,
        msg: "表名不能为空",
      };
    }
    const Table = Parse.Object.extend(className);
    const table = new Table();
    Object.keys(params).forEach((key) => {
      table.set(key, params[key]);
    });
    table.set("isDelete", false);
    table.set("hits", 0);
    table.set("company", {
      __type: "Pointer",
      className: "Company",
      objectId: companyId,
    });

    try {
      const result = await table.save();
      res.json(
        new ResponseJson().setCode(200).setMessage("添加成功").setData(result)
      );
    } catch (error) {
      res.json(
        new ResponseJson()
          .setCode(500)
          .setMessage("添加失败")
          .setData(error.toString())
      );
    }
  },

  updateById: async (req, res) => {
    const { objectId, companyId, className, params } = req.body;
    if (!className || !objectId) {
      throw {
        code: 401,
        msg: "表名不能为空",
      };
    }
    const table = new Parse.Query(className);
    table.equalTo("objectId", objectId);
    table.equalTo("company", companyId);
    const row = await table.first();
    if (row && row.id) {
      Object.keys(params).forEach((key) => {
        row.set(key, params[key] || row.get(key));
      });
      const result = await row.save();
      if (result && result.id) {
        res.json(
          new ResponseJson().setCode(200).setMessage("更新成功").setData(result)
        );
      } else {
        throw {
          code: 500,
          msg: "更新失败",
        };
      }
    } else {
      throw {
        code: 401,
        msg: "id不存在",
      };
    }
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
        msg: "id不存在",
      };
    }
  },

  /* 批量导入 */
  insertList: async (req, res) => {
    const { className, columns, columnsData, companyId } = req.body;
    if (!className) {
      throw {
        code: 401,
        msg: "表名不能为空",
      };
    } else if (!columns) {
      throw {
        code: 401,
        msg: "字段不能为空",
      };
    } else {
      try {
        const Table = Parse.Object.extend(className);
        for (const item of columnsData) {
          const table = new Table();
          columns.forEach((key) => {
            table.set(key, item[key]);
          });
          table.set("company", {
            __type: "Pointer",
            className: "Company",
            objectId: companyId,
          });
          await table.save();
        }
        res.json(
          new ResponseJson()
            .setCode(200)
            .setMessage("批量导入执行成功")
            .setData()
        );
      } catch (error) {
        res.json(
          new ResponseJson()
            .setCode(500)
            .setMessage("批量导入执行失败")
            .setData(error.toString())
        );
      }
    }
  },
};

module.exports = cmnController;
