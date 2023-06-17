const ResponseJson = _require("ResponseJson");
const userController = {
  signUp: async (req, res) => {
    const {
      username,
      password,
      email,
      companyId,
      identityId,
      nickname
    } =
      req.body;
    try {
      verify({
        username,
        password
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }

    try {
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
    } catch (error) {
      throw {
        code: 500,
        msg: error,
      };
    }


  },
  userExist: async (req, res) => {
    const {
      username
    } = req.query;
    try {
      verify({
        username
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
    const User = new Parse.Query("_User");
    User.equalTo("username", username);
    const exist = (await User.count()) === 0 ? false : true;
    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(exist)
    );
  },
  updateUser: async (req, res) => {
    const {
      username,
      password,
      email,
      nickname,
      objectId
    } = req.body;
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
    const {
      username,
      password
    } = req.body;
    try {
      try {
        verify({
          username,
          password
        })
      } catch (error) {
        throw {
          code: 401,
          msg: error,
        };
      }
      let user = (await Parse.User.logIn(username, password)).toJSON();
      user.company = (await ((new Parse.Query("Company")).equalTo("objectId", user.company.objectId)).first()).toJSON()
      const devModule = new Parse.Query("DevModule");
      devModule.equalTo("user", user.objectId);
      devModule.equalTo("isDelete", false);
      devModule.descending("createdAt");
      devModule.include(["user", "router.switchs", 'company']);
      user["modules"] = (await devModule.find()).map((module) => {
        module = module.toJSON();
        module.router = module.router.filter((route) => {
          return !route.isDelete;
        });
        return module;
      });
      res.json(
        new ResponseJson().setCode(200).setMessage("登陆成功").setData(Object.assign({}, user, { token: jwt.sign({ _id: user.objectId }) }))
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
  removeUser: async (req, res) => {
    const {
      objectId,
      up
    } = req.body
    try {
      verify({
        objectId,
        up
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
    const {
      username,
      password
    } = JSON.parse(up)
    const user = await Parse.User.logIn(username, password);
    user.set("isDelete", true);
    await user.save()
    res.json(
      new ResponseJson().setCode(200).setMessage("删除成功").setData(user)
    );
  }
};
module.exports = userController;