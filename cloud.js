Parse.Cloud.afterSave("Task", async function (request) {
  const task = request.object.toJSON();
  const classid = task.class.objectId;
  const taskid = task.objectId;
  const companyid = task.company.objectId;
  const Student = new Parse.Query("Student");
  Student.equalTo("class", classid);
  const students = (await Student.find()).map((item) => {
    return item.toJSON();
  });
  for (const stu of students) {
    const td = new Parse.Query("TaskDetail");
    td.equalTo("task", taskid);
    td.equalTo("student", stu.objectId);
    const count = await td.count();
    if (!count) {
      const TaskDetail = Parse.Object.extend("TaskDetail");
      const taskDetail = new TaskDetail();
      taskDetail.set("status", false);
      taskDetail.set("isDelete", false);
      taskDetail.set("company", {
        __type: "Pointer",
        className: "Company",
        objectId: companyid,
      });
      taskDetail.set("task", {
        __type: "Pointer",
        className: "Task",
        objectId: taskid,
      });
      taskDetail.set("class", {
        __type: "Pointer",
        className: "Class",
        objectId: classid,
      });
      taskDetail.set("student", {
        __type: "Pointer",
        className: "Student",
        objectId: stu.objectId,
      });
      await taskDetail.save();
    }
  }
});