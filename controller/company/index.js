const ResponseJson = _require("ResponseJson");
//const Parse = require("parse/node");
const companyController = {
  findList: async (req, res) => {
    let {
      isDelete = 'all'
    } = req.query
    const company = new Parse.Query("Company");
    if (String(isDelete) != 'all') {
      company.equalTo("isDelete", isDelete)
    }
    company.select("name", "objectId");
    company.descending("createdAt");
    const result = await company.find();
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },
};
module.exports = companyController;