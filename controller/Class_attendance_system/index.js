const ResponseJson = _require("ResponseJson");
const Query = _require("query");
const moment = require("moment");
/* const Parse = require("parse/node"); */
const Class_attendance_systemController = {
  student_login: async (req, res) => {
    const { studentID, loginPwd } = req.body;
    if (!studentID) {
      throw {
        code: 401,
        msg: "studentID不能为空",
      };
    } else if (!loginPwd) {
      throw {
        code: 401,
        msg: "loginPwd不能为空",
      };
    }
    try {
      const Student = new Parse.Query("Student");
      Student.equalTo("studentID", studentID);
      Student.equalTo("loginPwd", loginPwd);
      Student.include([
        "class.major",
        "class.department",
        "class.department.school",
      ]);
      const student = await Student.first();
      if (student.id) {
        res.json(
          new ResponseJson()
            .setCode(200)
            .setMessage("登录成功")
            .setData(student)
        );
      } else {
        throw {
          code: 1,
          msg: "账号或者密码错误",
        };
      }
    } catch (error) {
      throw {
        code: 500,
        msg: error,
      };
    }
  },
  task_list: async (req, res) => {
    const { studentid } = req.query;
    if (!studentid) {
      throw {
        code: 401,
        msg: "studentid不能为空",
      };
    }
    try {
      const myTask = new Parse.Query("TaskDetail");
      myTask.equalTo("student", studentid);
      const innerQuery = new Parse.Query("Task");
      innerQuery.equalTo("date", moment(new Date()).format("YYYY/MM/DD"));
      myTask.matchesQuery("task", innerQuery);
      myTask.includeAll();
      const list = await myTask.find();
      res.json(
        new ResponseJson().setCode(200).setMessage("成功").setData(list)
      );
    } catch (error) {
      throw {
        code: 500,
        msg: error,
      };
    }
  },
};
module.exports = Class_attendance_systemController;
