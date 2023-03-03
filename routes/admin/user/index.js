const express = require("express");
const userRouter = express.Router();
const userController = _require("controller/user/index");

/* 注册 */
userRouter.post("/signUp", userController.signUp);

/* 登录 */
userRouter.post("/loggingIn", userController.loggingIn);

/* 删除 */
userRouter.delete("/removeUser", userController.removeUser)

module.exports = userRouter;
