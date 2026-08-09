const ResponseJson = _require("ResponseJson");
const userController = _require("controller/user/index");
const axios = require("axios");
const crypto = require("crypto");

function miniAppCredentials() {
  const appId = process.env.WECHAT_APP_ID?.trim();
  const appSecret = process.env.WECHAT_APP_SECRET?.trim();
  const accountSecret = process.env.MINIAPP_ACCOUNT_SECRET?.trim();
  const companyId = process.env.MINIAPP_COMPANY_ID?.trim();
  const identityId = process.env.MINIAPP_IDENTITY_ID?.trim();
  if (!appId || !appSecret || !accountSecret || !companyId || !identityId) {
    throw new Error("MiniApp login is not configured");
  }
  return { appId, appSecret, accountSecret, companyId, identityId };
}

function accountPassword(openid, accountSecret) {
  return crypto
    .createHmac("sha256", accountSecret)
    .update(`miniapp:${openid}`)
    .digest("base64url");
}

function invokeUserController(method, request) {
  return new Promise((resolve, reject) => {
    Promise.resolve(userController[method](request, { json: resolve })).catch(reject);
  });
}

const miniappController = {
  login: async (req, res) => {
    if (process.env.ENABLE_LEGACY_MINIAPP_LOGIN !== "true") {
      return res.status(404).json(new ResponseJson().setCode(404).setMessage("MiniApp login is disabled"));
    }
    const {
      userInfo,
      code,
      cloudID,
      iv,
      signature
    } = req.body;
    let credentials;
    try {
      credentials = miniAppCredentials();
      verify({
        userInfo,
        code,
        companyId: credentials.companyId,
        identityId: credentials.identityId,
      });
    } catch (error) {
      return res.status(401).json(new ResponseJson().setCode(401).setMessage("MiniApp login is not configured"));
    }
    try {
      const { appId, appSecret, accountSecret, companyId, identityId } = credentials;
      const response = await axios.get("https://api.weixin.qq.com/sns/jscode2session", {
        params: { appid: appId, secret: appSecret, js_code: code, grant_type: "authorization_code" },
        timeout: 5000,
      });
      const openid = response.data?.openid;
      if (!openid) {
        return res.status(401).json(new ResponseJson().setCode(401).setMessage("MiniApp authentication failed"));
      }

      const password = accountPassword(openid, accountSecret);
      const exists = await invokeUserController("userExist", { query: { username: openid } });
      if (!exists.data) {
        const created = await invokeUserController("signUp", {
          body: {
            username: openid,
            password,
            email: "",
            companyId,
            identityId,
            nickname: userInfo?.nickName,
          },
        });
        if (created.code !== 200) {
          return res.status(500).json(new ResponseJson().setCode(500).setMessage("MiniApp account provisioning failed"));
        }
      }

      const session = await invokeUserController("loggingIn", { body: { username: openid, password } });
      return res.json(new ResponseJson().setCode(200).setMessage("success").setData(session));
    } catch (error) {
      return res.status(502).json(new ResponseJson().setCode(502).setMessage("MiniApp login failed"));
    }
  },
};
module.exports = miniappController;
