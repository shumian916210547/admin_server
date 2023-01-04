const express = require("express");
const Class_attendance_systemRouter = express.Router();
const Class_attendance_systemController = _require(
  "controller/Class_attendance_system/index"
);

Class_attendance_systemRouter.post(
  "/student_login",
  Class_attendance_systemController.student_login
); //学生登录

Class_attendance_systemRouter.get(
  "/task_list",
  Class_attendance_systemController.task_list
); //获取今天签到

Class_attendance_systemRouter.post(
  "/check_in",
  Class_attendance_systemController.check_in
); //签到

Class_attendance_systemRouter.get(
  "/findSchedule",
  Class_attendance_systemController.findSchedule
); //查询今天课程

module.exports = Class_attendance_systemRouter;
