let host = "localhost";

if (process.env.NODE_ENV == "development") {
  host = "localhost";
}

if (process.env.NODE_ENV == "production") {
  host = "114.215.210.204";
}

module.exports = {
  user: "shumian",
  database: "postgres",
  password: "100329",
  host,
  port: 5432,
};
