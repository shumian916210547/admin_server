const ResponseJson = _require("ResponseJson");
const Query = _require("query");
const Parse = require("parse/node");
const devRouteController = {
  findAll: async (req, res) => {
    const { pageSize, pageNum } = req.query;
    const devRoute = new Parse.Query("DevRoute");
    devRoute.equalTo("isDelete", false);
    const total = await devRoute.count();
    devRoute.include("router");
    devRoute.limit(Number(pageSize) || 10);
    devRoute.skip(Number(pageSize * (pageNum - 1)) || 0);
    const result = await devRoute.find();
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData({ count: total, curPage: pageNum || 1, list: result })
    );
  },
  findById: async (req, res) => {
    const { objectId } = req.query;
    if (!objectId) {
      throw {
        code: 401,
        msg: "objectId不能为空",
      };
    }
    const devRoute = new Parse.Query("DevRoute");
    devRoute.equalTo("objectId", objectId);
    devRoute.equalTo("isDelete", false);
    devRoute.include("router");
    const result = await devRoute.first();
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },
  insertDevRoute: async (req, res) => {
    const { pagePath, name, path } = req.body;
    if (!pagePath || !name || !path) {
      throw {
        msg: "pagePath, name, path不能为空",
        code: 401,
      };
    }

    const DevRoute = Parse.Object.extend("DevRoute");
    const devRoute = new DevRoute();
    devRoute.set("name", name);
    devRoute.set("path", path);
    devRoute.set("pagePath", pagePath);
    devRoute.set("isDelete", false);
    const result = await devRoute.save();
    if (result && result.id) {
      res.json(
        new ResponseJson().setCode(200).setMessage("添加成功").setData(result)
      );
    } else {
      throw {
        code: 500,
        msg: "新增失败",
      };
    }
  },
  updateById: async (req, res) => {
    const { objectId, pagePath, name, path } = req.body;
    if (!objectId) {
      throw {
        code: 401,
        msg: "objectId不能为空",
      };
    }

    const devRoute = new Parse.Query("DevRoute");
    devRoute.equalTo("objectId", objectId);
    const route = await devRoute.first();
    if (route && route.id) {
      route.set("pagePath", pagePath || route.get("pagePath"));
      route.set("name", name || route.get("name"));
      route.set("path", path || route.get("path"));
      const result = await route.save();
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
        msg: "路由不存在",
      };
    }
  },
  removeById: async (req, res) => {
    const { objectId } = req.body;
    const devRoute = new Parse.Query("DevRoute");
    devRoute.equalTo("objectId", objectId);
    const route = await devRoute.first();
    if (route && route.id) {
      route.set("isDelete", true);
      const result = await route.save();
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

module.exports = devRouteController;
