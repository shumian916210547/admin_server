const ResponseJson = _require("ResponseJson");
const Query = _require("query");
const Parse = require("parse/node");
const devModuleController = {
  findAll: async (req, res) => {
    const { companyId } = req.body
    const { pageSize, pageNum } = req.query;
    const devModule = new Parse.Query("devModule");
    devModule.equalTo("company", companyId)
    const total = await devModule.count();
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
  insertDevModule: async (req, res) => {
    const { path, meta, name, companyId } = req.body;
    if (!path || !meta || !name) {
      throw {
        code: 401,
        msg: "path, meta, name不能为空",
      };
    }
    const DevModule = Parse.Object.extend("devModule");
    const devModule = new DevModule();
    devModule.set("name", name);
    devModule.set("path", path);
    devModule.set("meta", meta);
    devModule.set("company", {
      __type: "Pointer",
      className: "company",
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
  }
};

module.exports = devModuleController;
