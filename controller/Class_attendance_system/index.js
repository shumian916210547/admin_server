const ResponseJson = _require("ResponseJson");

const moment = require("moment");

const Class_attendance_systemController = {
  student_login: async (req, res) => {
    const { studentID, loginPwd } = req.body;
    try {
      verify({
        studentID, loginPwd
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
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
    try {
      verify({
        studentid
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
    try {
      const myTask = new Parse.Query("TaskDetail");
      myTask.equalTo("student", studentid);
      myTask.equalTo("isDelete", false);
      const innerQuery = new Parse.Query("Task");
      innerQuery.equalTo("isDelete", false);
      innerQuery.equalTo("date", moment(new Date()).format("YYYY/MM/DD"));
      myTask.matchesQuery("task", innerQuery);
      myTask.include(["task.course", "class"]);
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
  check_in: async (req, res) => {
    const { studentid, code, time, tdid } = req.body;
    try {
      verify({
        studentid, code, time, tdid
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
    try {
      const TD = new Parse.Query("TaskDetail");
      TD.equalTo("objectId", tdid);
      TD.equalTo("student", studentid);
      const innerQuery = new Parse.Query("Task");
      innerQuery.equalTo("code", code);
      /* innerQuery.greaterThan(
        "start_time",
        moment(new Date(time)).format("HH:mm:ss")
      );
      innerQuery.lessThan(
        "end_time",
        moment(new Date(time)).format("YYYY/MM/DD HH:mm:ss")
      ); */
      TD.matchesQuery("task", innerQuery);
      const Td = await TD.first();
      if (Td && Td.id) {
        Td.set("time", moment(new Date(time)).format("YYYY/MM/DD HH:mm:ss"));
        Td.set("status", true);
        const r = await Td.save();
        if (r.id) {
          res.json(
            new ResponseJson().setCode(200).setMessage("签到成功").setData(r)
          );
        }
      } else {
        res.json(
          new ResponseJson().setCode(404).setMessage("签到失败").setData()
        );
      }
    } catch (error) {
      throw {
        code: 500,
        msg: error,
      };
    }
  },
  findSchedule: async (req, res) => {
    const { date, studentid, classid } = req.query;
    const Schedule = new Parse.Query("Schedule");
    const Class = new Parse.Query("Class");
    const Student = new Parse.Query("Student");
    Student.equalTo("isDelete", "false");
    Student.equalTo("objectId", studentid);
    Class.equalTo("objectId", classid);
    Class.equalTo("isDelete", "false");
    Student.matchesQuery("class", Class);
    const count = await Student.count();
    if (count) {
      Schedule.equalTo("date", moment(new Date(date)).format("YYYY/MM/DD"));
      Schedule.matchesQuery("class", Class);
      Schedule.include(["course", "teacher", "class"]);
      const r = await Schedule.find();
      res.json(
        new ResponseJson().setCode(200).setMessage("success").setData(r)
      );
    }
  },
};
module.exports = Class_attendance_systemController;
