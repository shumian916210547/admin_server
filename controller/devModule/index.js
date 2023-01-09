const ResponseJson = _require("ResponseJson");
const Query = _require("query");
//const Parse = require("parse/node");
const moment = require("moment");
const devModuleController = {
  findAll: async (req, res) => {
    const { pageSize, pageNum, name = "" } = req.query;
    const devModule = new Parse.Query("DevModule");
    if (name && name.length) {
      devModule.contains("name", name);
    }
    devModule.equalTo("isDelete", false);
    const total = await devModule.count();
    devModule.equalTo("isDelete", false);
    devModule.ascending("createdAt");
    devModule.includeAll();
    devModule.limit(Number(pageSize) || 10);
    devModule.skip(Number(pageSize * (pageNum - 1)) || 0);
    const result = (await devModule.find()).map((module) => {
      module = module.toJSON();
      module.createdAt = moment(new Date(module.createdAt)).format(
        "YYYY-MM-DD HH:mm:ss"
      );
      module.router = module.router.filter((route) => {
        return !route.isDelete;
      });
      return module;
    });
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData({ count: total, curPage: pageNum || 1, list: result })
    );
  },
  findList: async (req, res) => {
    const devModule = new Parse.Query("DevModule");
    devModule.descending("createdAt");
    devModule.equalTo("isDelete", false);
    devModule.includeAll();
    const result = (await devModule.find()).map((module) => {
      module = module.toJSON();
      module.router = module.router.filter((route) => {
        return !route.isDelete;
      });
      return module;
    });
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
    const devModule = new Parse.Query("DevModule");
    devModule.equalTo("objectId", objectId);
    devModule.equalTo("isDelete", false);
    devModule.include("router");
    const result = await devModule.first();
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData(result || {})
    );
  },
  insertDevModule: async (req, res) => {
    const { name, router, meta, user } = req.body;
    if (!name || !meta.companyId) {
      throw {
        code: 401,
        msg: " name,meta.companyId不能为空",
      };
    }
    let routes = router?.map((route) => {
      return {
        __type: "Pointer",
        className: "DevRoute",
        objectId: route,
      };
    });
    const DevModule = Parse.Object.extend("DevModule");
    const devModule = new DevModule();
    devModule.set("name", name);
    devModule.set("isDelete", false);
    devModule.set("meta", meta);
    devModule.set("router", routes || []);
    devModule.set("user", {
      __type: "Pointer",
      className: "_User",
      objectId: user,
    });
    const result = await devModule.save();
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
  updateById: async (req, res) => {
    const { objectId, name, router, meta, user } = req.body;
    if (!objectId || !name || !meta.companyId) {
      throw {
        code: 401,
        msg: "objectId,name,meta.companyId不能为空",
      };
    }
    const devModule = new Parse.Query("DevModule");
    devModule.equalTo("objectId", objectId);
    const module = await devModule.first();
    if (module && module.id) {
      let routes = router?.map((route) => {
        return {
          __type: "Pointer",
          className: "DevRoute",
          objectId: route,
        };
      });
      module.set("name", name || module.get("name"));
      module.set("router", routes || module.get("router"));
      module.set("meta", meta || module.get("meta"));
      module.set(
        "user",
        {
          __type: "Pointer",
          className: "_User",
          objectId: user,
        } || module.get("user")
      );
      const result = await module.save();
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
        msg: "模块不存在",
      };
    }
  },
  removeById: async (req, res) => {
    const { objectId } = req.body;
    const devModule = new Parse.Query("DevModule");
    devModule.equalTo("objectId", objectId);
    const module = await devModule.first();
    if (module && module.id) {
      module.set("isDelete", true);
      const result = await module.save();
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

module.exports = devModuleController;
