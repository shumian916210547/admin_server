const jwt = require("jsonwebtoken");
const { config } = require("../config/env");

const signingOptions = {
  algorithm: "HS256",
  expiresIn: config.auth.ttlSeconds,
  issuer: "shumian-admin-api",
  audience: "shumian-admin-web",
};

const sign = (data = {}) => jwt.sign(data, config.auth.jwtSecret, signingOptions);

const verify = (req, res, next) => {
  const authorization = req.headers.authorization || req.body?.token || req.query?.token || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;

  try {
    const data = jwt.verify(token, config.auth.jwtSecret, {
      algorithms: ["HS256"],
      issuer: signingOptions.issuer,
      audience: signingOptions.audience,
    });
    req._id = data._id || data.sub;
    next();
  } catch {
    res.status(401).json({ code: 401, msg: "token verification failed" });
  }
};

module.exports = { sign, verify };
