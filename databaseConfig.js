let host = "localhost";

/* if (process.env.NODE_ENV == "development") {
  host = "localhost";
}

if (process.env.NODE_ENV == "production") {
  host = "api.shumian.top";
}
 */
module.exports = {
  user: "postgres",
  database: "postgres",
  password: "100329",
  port: 5432,
  host,
};
