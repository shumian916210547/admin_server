const ResponseJson = _require("ResponseJson");
const Query = _require("query");
const moment = require("moment");
//const Parse = require("parse/node");
const devRouteController = {
  findAll: async (req, res) => {
    const { pageSize, pageNum, name = "" } = req.query;
    const devRoute = new Parse.Query("DevRoute");
    if (name && name.length) {
      devRoute.contains("name", name);
    }
    devRoute.equalTo("isDelete", false);
    const total = await devRoute.count();
/*     const Switch = new Parse.Query("Switch");
    Switch.select("objectId", "name");
    devRoute.matchesQuery("switchs", Switch); */
    devRoute.ascending("createdAt");
    devRoute.includeAll();
    devRoute.limit(Number(pageSize) || 10);
    devRoute.skip(Number(pageSize * (pageNum - 1)) || 0);
    const result = (await devRoute.find()).map((route) => {
      route = route.toJSON();
      route.createdAt = moment(new Date(route.createdAt)).format(
        "YYYY-MM-DD HH:mm:ss"
      );
      return route;
    });
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData({ count: total, curPage: pageNum || 1, list: result })
    );
  },
  findList: async (req, res) => {
    const devRoute = new Parse.Query("DevRoute");
    devRoute.ascending("createdAt");
    devRoute.equalTo("isDelete", false);
    devRoute.includeAll();
    const result = await devRoute.find(); /* .map((route) => {
      return {
        value: route.id,
        label: route.get("name"),
      };
    }) */
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
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
    const { pagePath, name, path, option, switchs } = req.body;
    if (!pagePath || !name || !path) {
      throw {
        msg: "pagePath, name, path不能为空",
        code: 401,
      };
    }
    let Switchs = switchs?.map((item) => {
      return {
        __type: "Pointer",
        className: "Switch",
        objectId: item,
      };
    });
    const DevRoute = Parse.Object.extend("DevRoute");
    const devRoute = new DevRoute();
    devRoute.set("name", name);
    devRoute.set("path", path);
    devRoute.set("pagePath", pagePath);
    devRoute.set("isDelete", false);
    devRoute.set("option", option);
    devRoute.set("switchs", Switchs || []);
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
    const { objectId, pagePath, name, path, option, switchs } = req.body;
    if (!objectId) {
      throw {
        code: 401,
        msg: "objectId不能为空",
      };
    }
    console.log(switchs);
    let Switchs = switchs?.map((item) => {
      return {
        __type: "Pointer",
        className: "Switch",
        objectId: item,
      };
    });
    const devRoute = new Parse.Query("DevRoute");
    devRoute.equalTo("objectId", objectId);
    const route = await devRoute.first();
    if (route && route.id) {
      route.set("pagePath", pagePath || route.get("pagePath"));
      route.set("name", name || route.get("name"));
      route.set("path", path || route.get("path"));
      route.set("option", option || route.get("route"));
      route.set("switchs", Switchs || route.get("switchs"));
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
  updateOption: async (req, res) => {
    const { className, fieldState } = req.body;
    if (!className || !fieldState) {
      throw {
        code: 401,
        msg: "className, fieldState 不能为空",
      };
    }

    let DevRoute = new Parse.Query("DevRoute");
    DevRoute.equalTo("option.className", className);
    const devRoute = await DevRoute.first();
    if (devRoute.get("option").fields[fieldState.name]) {
      let option = devRoute.get("option");
      delete option.fields[fieldState.name];
      option.fields[fieldState.name] = fieldState;
      delete option.fields[fieldState.name].name;
      devRoute.set("option", option);
      const result = await devRoute.save();
      res.json(
        new ResponseJson().setCode(200).setMessage("更新成功").setData(result)
      );
    } else {
      throw {
        code: 404,
        msg: "option不存在字段" + fieldState.name,
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
