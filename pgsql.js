const pg = require("pg");
const databaseConfig = require("./databaseConfig");
let connection;
function clientDataBase() {
  try {
    connection = new pg.Client(databaseConfig);
    connection.end((error) => {
      if (!error) {
        console.log("数据库连接成功");
      }
    });
  } catch (error) {
    console.log(error);
    setTimeout(() => {
      clientDataBase();
    }, 1000);
  }
}
clientDataBase();
module.exports = connection;
