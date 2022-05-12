const ResponseJson = _require("ResponseJson");
const Parse = require("parse/node");
const Query = _require("query");
const schemaController = {
  findList: async (req, res) => {
    let sql = `select * from "_SCHEMA"`;
    const result = await Query(sql);
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },
};
module.exports = schemaController;
