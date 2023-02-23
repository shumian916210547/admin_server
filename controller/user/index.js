const ResponseJson = _require("ResponseJson");
//const Parse = require("parse/node");
const userController = {
  signUp: async (req, res) => {
    const { username, password, email, companyId, identityId, nickname } =
      req.body;
    if (!username || !password) {
      throw {
        code: 401,
        msg: " username, password不能为空",
      };
    }
    const user = new Parse.User();
    user.set("username", username);
    user.set("password", password);
    user.set("nickname", nickname);
    user.set("isDelete", false);
    user.set("email", email || undefined);
    user.set("authData", {});
    user.set("company", {
      __type: "Pointer",
      className: "Company",
      objectId: companyId,
    });
    user.set("identity", {
      __type: "Pointer",
      className: "Identity",
      objectId: identityId,
    });
    const result = await user.signUp();
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData(result.toJSON())
    );
  },
  userExist: async (req, res) => {
    const { username } = req.query;
    const User = new Parse.Query("_User");
    User.equalTo("username", username);
    const exist = (await User.count()) === 0 ? false : true;
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(exist)
    );
  },
  updateUser: async (req, res) => {
    const { username, password, email, nickname,objectId } = req.body;
    const User = new Parse.Query("_User");
    User.equalTo("username", username);
    User.equalTo("objectId", objectId);
    const user = await User.first();
    user.set("password", password || user.get("password"));
    user.set("nickname", nickname || user.get("nickname"));
    user.set("email", email || user.get("email"));
    const result = await user.save();
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData(result.toJSON())
    );
  },
  loggingIn: async (req, res) => {
    const { username, password } = req.body;
    try {
      if (!username || !password) {
        throw {
          code: 401,
          msg: " username, password不能为空",
        };
      }
      let user = (await Parse.User.logIn(username, password)).toJSON();
      const devModule = new Parse.Query("DevModule");
      devModule.equalTo("user", user.objectId);
      devModule.equalTo("isDelete", false);
      devModule.descending("createdAt");
      devModule.include(["user", "router.switchs"]);
      user["modules"] = (await devModule.find()).map((module) => {
        module = module.toJSON();
        module.router = module.router.filter((route) => {
          return !route.isDelete;
        });
        return module;
      });
      res.json(
        new ResponseJson().setCode(200).setMessage("登陆成功").setData(user)
      );
    } catch (error) {
      res.json(
        new ResponseJson()
          .setCode(500)
          .setMessage("登陆失败")
          .setData(error.toString())
      );
    }
  },
};
module.exports = userController;
