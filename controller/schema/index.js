const ResponseJson = _require("ResponseJson");
/* const Parse = require("parse/node"); */
const Query = _require("query");
const schemaController = {
  findList: async (req, res) => {
    const DevSchema = new Parse.Query("DevSchema");
    DevSchema.equalTo("isDelete", false);
    DevSchema.ascending("createdAt");
    const result = await DevSchema.find();
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },

  insertSchema: async (req, res) => {
    const { name, companyId } = req.body;
    if (!name) {
      throw {
        code: 401,
        msg: "schema名称不能为空",
      };
    }

    let schema = new Parse.Schema(name);
    schema.addPointer("company", "Company");
    schema.save().then((result) => {
      if (result && result.className == name) {
        const DevSchema = Parse.Object.extend("DevSchema");
        const devSchema = new DevSchema();
        devSchema.set("name", result.className);
        devSchema.set("isDelete", false);
        devSchema.set("fields", {});
        devSchema.set("company", {
          __type: "Pointer",
          className: "Company",
          objectId: companyId,
        });
        devSchema.save().then((record) => {
          if (record && record.id) {
            res.json(
              new ResponseJson()
                .setCode(200)
                .setMessage("新建成功")
                .setData(record)
            );
          }
        });
      }
    });
  },

  updateById: async (req, res) => {
    const {
      name,
      type,
      required,
      chineseName,
      targetClass,
      schemaId,
      defaultValue,
      editComponent,
      dataSource,
    } = req.body;
    let DevSchema = new Parse.Query("DevSchema");
    DevSchema.equalTo("objectId", schemaId);
    const devSchema = await DevSchema.first();
    if (devSchema && devSchema.id) {
      devSchema.set(
        "fields",
        Object.assign({}, devSchema.get("fields"), {
          [name]: {
            type,
            required,
            chineseName,
            targetClass,
            default: defaultValue,
            editComponent,
            dataSource,
          },
        })
      );
      const record = await devSchema.save();
      if (record.id) {
        const schema = new Parse.Schema(devSchema.get("name"));
        schema.addField(name, type, {
          required,
          chineseName,
          targetClass,
          default: defaultValue,
          editComponent,
          dataSource,
        });

        schema.update().then((result) => {
          res.json(
            new ResponseJson()
              .setCode(200)
              .setMessage("更新成功")
              .setData(result)
          );
        });
      }
    } else {
      throw {
        code: 404,
        msg: "此id不存在",
      };
    }
  },

  removeFields: async (req, res) => {
    const { schemaId, fieldsName } = req.body;
    if (!schemaId || !fieldsName) {
      throw {
        code: 401,
        msg: "schemaId, fieldsName 不能为空",
      };
    }

    const DevSchema = new Parse.Query("DevSchema");
    DevSchema.equalTo("objectId", schemaId);
    const devSchema = await DevSchema.first();
    let fields = devSchema.get("fields");
    if (!fields[fieldsName]) {
      throw {
        code: 404,
        msg: "字段不存在",
      };
    }
    delete fields[fieldsName];
    const schema = new Parse.Schema(devSchema.get("name"));
    schema.deleteField(fieldsName);
    schema.update().then(async () => {
      devSchema.set("fields", fields);
      const result = await devSchema.save();
      res.json(
        new ResponseJson().setCode(200).setMessage("删除成功").setData(result)
      );
    });
  },
};
module.exports = schemaController;
