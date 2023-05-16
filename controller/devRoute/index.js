const ResponseJson = _require("ResponseJson");

const moment = require("moment");

const devRouteController = {
  findAll: async (req, res) => {
    const {
      pageSize,
      pageNum,
      name = "",
      companyId
    } = req.query;
    const devRoute = new Parse.Query("DevRoute");
    if (name && name.length) {
      devRoute.contains("name", name);
    }
    devRoute.equalTo("isDelete", false);
    devRoute.equalTo("company", companyId)
    const total = await devRoute.count();
    devRoute.descending("createdAt");
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
        .setData({
          count: total,
          curPage: pageNum || 1,
          list: result
        })
    );
  },
  findList: async (req, res) => {
    const {
      companyId
    } = req.query
    const devRoute = new Parse.Query("DevRoute");
    devRoute.descending("createdAt");
    devRoute.equalTo("isDelete", false);
    devRoute.equalTo("company", companyId)
    devRoute.includeAll();
    const result = await devRoute.find();
    /* .map((route) => {
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
    const {
      objectId
    } = req.query;

    try {
      verify({
        objectId
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
    const devRoute = new Parse.Query("DevRoute");
    devRoute.equalTo("objectId", objectId);
    /* devRoute.equalTo("isDelete", false); */
    devRoute.include("router");
    const result = await devRoute.first();
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },
  insertDevRoute: async (req, res) => {
    const {
      pagePath,
      name,
      path,
      option,
      switchs
    } = req.body;
    const {
      companyId
    } = req.query
    try {
      verify({
        pagePath,
        name,
        path,
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
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
    devRoute.set({
      __type: "Pointer",
      className: "Company",
      objectId: companyId
    })
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
    const {
      objectId,
      pagePath,
      name,
      path,
      option,
      switchs,
      isDelete
    } = req.body;
    try {
      verify({
        objectId
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
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
      route.set("isDelete", isDelete == null ? route.get("isDelete") : isDelete);
      console.log(route.toJSON());
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
    const {
      className,
      fieldState
    } = req.body;

    try {
      verify({
        className,
        fieldState
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
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
    const {
      objectId
    } = req.body;
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