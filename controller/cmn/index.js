const ResponseJson = _require("ResponseJson");

const moment = require("moment");
const fs = require('fs')
const path = require('path')
//const Parse = require("parse/node");
const cmnController = {
  findAll: async (req, res) => {
    const {
      className,
      companyId,
      pageSize,
      pageNum,
      name = ""
    } = req.query;
    try {
      verify({
        className
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
    const table = new Parse.Query(className);
    if (name && name.length) {
      table.contains("name", name);
    }
    table.equalTo("isDelete", false);
    table.equalTo("company", companyId);
    const total = await table.count();
    table.descending("createdAt");
    table.limit(Number(pageSize) || 10);
    table.skip(Number(pageSize * (pageNum - 1)) || 0);
    table.includeAll();
    const result = (await table.find()).map((item) => {
      item = item.toJSON();
      item.createdAt = moment(new Date(item.createdAt)).format(
        "YYYY-MM-DD HH:mm:ss"
      );
      return item;
    });

    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData({
          count: total,
          curPage: pageNum || 1,
          list: result
        })
    );
  },

  findList: async (req, res) => {
    let {
      className,
      companyId,
      name = "",
      equalTo = {}
    } = req.query;
    try {
      verify({
        className
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }

    const table = new Parse.Query(className);
    if (name && name.length) {
      table.contains("name", name);
    }
    table.descending("createdAt");
    if (typeof equalTo === 'string') {
      equalTo = JSON.parse(equalTo)
    }
    if (equalTo && Object.keys(equalTo).length) {
      Object.keys(equalTo).forEach(k => {
        table.equalTo(k, equalTo[k]);
      })
    }
    table.equalTo("isDelete", false);
    table.equalTo("company", companyId);
    const result = (await table.find()).map((item) => {
      item = item.toJSON();
      item.createdAt = moment(new Date(item.createdAt)).format(
        "YYYY-MM-DD HH:mm:ss"
      );
      return item;
    });

    res.json(
      new ResponseJson().setCode(200).setMessage("success").setData(result)
    );
  },

  insert: async (req, res) => {
    const {
      params,
      className,
      companyId
    } = req.body;

    try {
      verify({
        className
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }

    const t = new Parse.Query("DevSchema");
    t.equalTo("name", className);
    t.select("fields");
    let t_obj = (await t.first()).toJSON();
    const Table = Parse.Object.extend(className);
    const table = new Table();
    Object.keys(params).forEach((key) => {
      if (t_obj.fields[key].type == "Pointer") {
        table.set(key, {
          __type: "Pointer",
          className: t_obj.fields[key].targetClass,
          objectId: params[key],
        });
      } else {
        table.set(key, params[key] || t_obj.fields[key].default);
      }
    });
    table.set("isDelete", false);
    table.set("company", {
      __type: "Pointer",
      className: "Company",
      objectId: companyId,
    });

    try {
      const result = await table.save();
      res.json(
        new ResponseJson().setCode(200).setMessage("添加成功").setData(result)
      );
    } catch (error) {
      res.json(
        new ResponseJson()
          .setCode(500)
          .setMessage("添加失败")
          .setData(error.toString())
      );
    }
  },

  updateById: async (req, res) => {
    const {
      objectId,
      companyId,
      className,
      params
    } = req.body;
    try {
      verify({
        objectId,
        className
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
    const t = new Parse.Query("DevSchema");
    t.equalTo("name", className);
    t.select("fields");
    let t_obj = (await t.first()).toJSON();
    const table = new Parse.Query(className);
    table.equalTo("objectId", objectId);
    table.equalTo("company", companyId);
    const row = await table.first();
    if (row && row.id) {
      Object.keys(params).forEach((key) => {
        if (t_obj.fields[key].type == "Pointer") {
          row.set(key, {
            __type: "Pointer",
            className: t_obj.fields[key].targetClass,
            objectId: params[key]?.objectId || params[key],
          });
        } else {
          if (params[key] != undefined) {
            row.set(key, params[key]);
          } else {
            row.set(key, row.get(key));
          }
        }
      });
      const result = await row.save();
      if (result && result.id) {
        res.json(
          new ResponseJson().setCode(200).setMessage("更新成功").setData(result)
        );
      } else {
        throw new Error(`code: 500,msg: "更新失败"`);
      }
    } else {
      throw new Error(`code: 401,msg: "id不存在"`);
    }
  },

  removeById: async (req, res) => {
    const {
      objectId,
      companyId,
      className
    } = req.body;
    const table = new Parse.Query(className);
    table.equalTo("objectId", objectId);
    table.equalTo("company", companyId);
    const row = await table.first();
    if (row && row.id) {
      row.set("isDelete", true);
      const result = await row.save();
      if (result && result.id) {
        res.json(
          new ResponseJson().setCode(200).setMessage("删除成功").setData(result)
        );
      } else {
        throw new Error(`code: 500,msg: "删除失败"`);
      }
    } else {
      throw new Error(`code: 401,msg: "id不存在"`);
    }
  },

  /* 批量导入 */
  insertList: async (req, res) => {
    const {
      className,
      columns,
      columnsData,
      companyId
    } = req.body;

    try {
      verify({
        className,
        columns
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }
    try {
      const Table = Parse.Object.extend(className);
      for (const item of columnsData) {
        const table = new Table();
        columns.forEach((key) => {
          table.set(key, item[key]);
        });
        table.set("company", {
          __type: "Pointer",
          className: "Company",
          objectId: companyId,
        });
        await table.save();
      }
      res.json(
        new ResponseJson()
          .setCode(200)
          .setMessage("批量导入执行成功")
          .setData()
      );
    } catch (error) {
      res.json(
        new ResponseJson()
          .setCode(500)
          .setMessage("批量导入执行失败")
          .setData(error.toString())
      );
    }
  },

  getClientIP: async (req, res) => {
    let ip =
      req.headers["x-real-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.connection.remoteAddres ||
      req.socket.remoteAddress ||
      "";
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("success")
        .setData(ip)
    );
  },

  uploadFile: async (req, res) => {
    const {
      userid
    } = req.body;
    try {
      verify({
        userid
      })
    } catch (error) {
      throw {
        code: 401,
        msg: error,
      };
    }

    const oldPath = req.file.path
    let name = Buffer.from(req.file.originalname, "latin1").toString("utf8")
    let newPath = static + userid + '/' + today + "/" + name
    let newPatht = static + userid + '/' + today + "/" + req.file.originalname
    const dir = ['resources', '/' + userid, '/' + year, '/' + month, '/' + day]
    let p = ''
    for (const d of dir) {
      p += d
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p)
      }
    }
    if (fs.existsSync(newPath)) {
      fs.unlinkSync(newPath)
    } else if (fs.existsSync(newPatht)) {
      fs.unlinkSync(newPatht)
    }
    try {
      fs.renameSync(oldPath, newPath)
    } catch (error) {
      name = req.file.originalname
      newPath = newPatht
      fs.renameSync(oldPath, newPath)
    }
    res.json(
      new ResponseJson()
        .setCode(200)
        .setMessage("上传成功")
        .setData({
          url: process.env.ServerHost + '/cmn/readFile/' + newPath,
          name,
          size: req.file.size,
          mimetype: req.file.mimetype
        })
    );
  },

  readFile: async (req, res) => {
    const {
      uid,
      year,
      month,
      day,
      filename
    } = req.params
    const filepath = 'resources/' + uid + '/' + year + '/' + month + '/' + day + '/' + filename
    res.sendFile(path.join(process.cwd(), filepath))
  }
};

module.exports = cmnController;