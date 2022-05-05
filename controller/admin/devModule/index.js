const ResponseJson = _require("ResponseJson");
const Query = _require("query");
const Parse = require("parse/node");
const devModuleController = {
  findAll: async (req, res) => {
    const { companyId } = req.body;
    const { pageSize, pageNum } = req.query;
    const devModule = new Parse.Query("DevModule");
    devModule.equalTo("company", companyId);
    devModule.equalTo("isDelete", false);
    const total = await devModule.count();
    devModule.include("router");
    devModule.limit(Number(pageSize) || 10);
    devModule.skip(Number(pageSize * (pageNum - 1)) || 0);
    const result = await devModule.find();
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
    const { meta, name, companyId, routes } = req.body;
    if (!meta || !name) {
      throw {
        code: 401,
        msg: "meta, name不能为空",
      };
    }
    let router = routes?.map((route) => {
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
    devModule.set("router", router || []);
    devModule.set("company", {
      __type: "Pointer",
      className: "Company",
      objectId: companyId,
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
    const { objectId, meta, name, routes } = req.body;
    if (!objectId) {
      throw {
        code: 401,
        msg: "objectId不能为空",
      };
    }
    const devModule = new Parse.Query("DevModule");
    devModule.equalTo("objectId", objectId);
    const module = await devModule.first();
    if (module && module.id) {
      let router = routes?.map((route) => {
        return {
          __type: "Pointer",
          className: "DevRoute",
          objectId: route,
        };
      });
      module.set("meta", meta || module.get("meta"));
      module.set("name", name || module.get("name"));
      module.set("router", router || module.get("router"));
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
