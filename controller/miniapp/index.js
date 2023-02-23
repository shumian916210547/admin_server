const ResponseJson = _require("ResponseJson");
const userController = _require("controller/user/index");
const axios = require("axios");
const miniappController = {
  login: (req, res) => {
    const { userInfo, code, cloudID, iv, signature, companyId } = req.body;
    axios
      .get(
        `https://api.weixin.qq.com/sns/jscode2session?appid=wxa77679be2e21b583&secret=884b9a13e8923371ff2eb36d6d5a3d62&js_code=${code}&grant_type=authorization_code`
      )
      .then((response) => {
        userController.userExist(
          { query: { username: response.data.openid } },
          {
            json: (r) => {
              if (!r.data) {
                userController.signUp(
                  {
                    body: {
                      username: response.data.openid,
                      password: "123456",
                      email: "",
                      companyId,
                      identityId: "Ptj4EqxwIl",
                      nickname: userInfo.nickName,
                    },
                  },
                  {
                    json: (s) => {
                      if (s.code == 200) {
                        userController.loggingIn(
                          {
                            body: {
                              username: response.data.openid,
                              password: "123456",
                            },
                          },
                          {
                            json: (u) =>
                              res.json(
                                new ResponseJson()
                                  .setCode(200)
                                  .setMessage("success")
                                  .setData(u)
                              ),
                          }
                        );
                      }
                    },
                  }
                );
              } else {
                userController.loggingIn(
                  {
                    body: {
                      username: response.data.openid,
                      password: "123456",
                    },
                  },
                  {
                    json: (u) =>
                      res.json(
                        new ResponseJson()
                          .setCode(200)
                          .setMessage("success")
                          .setData(u)
                      ),
                  }
                );
              }
            },
          }
        );
      });
    /* wxa77679be2e21b583 */
    /* 884b9a13e8923371ff2eb36d6d5a3d62 */
  },
};
module.exports = miniappController;
