const ResponseJson = _require("ResponseJson");
const Parse = require("parse/node");
const companyController = {
  findList: async (req, res) => {
    const company = new Parse.Query("Company");
    company.select("name", "objectId");
    const result = await company.find();
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },
};
module.exports = companyController;
