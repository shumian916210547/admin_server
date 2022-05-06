const ResponseJson = _require("ResponseJson");
const Parse = require("parse/node");
const userController = {
  signUp: async (req, res) => {
    const { username, password, email } = req.body;
    if (!username || !password || !email) {
      throw {
        code: 401,
        msg: " username, password, email不能为空",
      };
    }
    const user = new Parse.User();
    user.set("username", username);
    user.set("password", password);
    user.set("email", email);
    user.set("authData", {});
    const result = await user.signUp();
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },
  loggingIn: async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      throw {
        code: 401,
        msg: " username, password不能为空",
      };
    }
    const user = await Parse.User.logIn(username, password);
    res.json(
      new ResponseJson().setCode(200).setMessage("登陆成功").setData(user)
    );
  },
};
module.exports = userController;
