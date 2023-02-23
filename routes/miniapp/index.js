const express = require("express");
const miniappRouter = express.Router();
const miniappController = _require("controller/miniapp/index");
/* 登录 */
miniappRouter.post("/login", miniappController.login);

module.exports = miniappRouter;
