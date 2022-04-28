const pg = require("pg");
const databaseConfig = require("./databaseConfig")
const connection = new pg.Client(databaseConfig)
module.exports = connection;