const connection = require("./pgsql")

const Query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    connection.query(sql, [...params],
      (error, result, fields) => {
        if (!error) {
          resolve(result)
        } else {
          reject(error)
        }
      }
    )
  })
}

module.exports = Query