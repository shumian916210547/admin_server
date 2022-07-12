const pg = require("pg");
const databaseConfig = require("./databaseConfig");
let connection = {
  client: undefined,
  clientDataBase: () => {
    try {
      connection.client = new pg.Client(databaseConfig);
      connection.client.end((error) => {
        if (!error) {
          console.log("数据库连接成功");
        }
      });
    } catch (error) {
      console.log(error);
    }
  },
};
module.exports = connection;
