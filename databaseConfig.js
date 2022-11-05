let host = "localhost";

if (process.env.NODE_ENV == "development") {
  host = "localhost";
}

if (process.env.NODE_ENV == "production") {
  host = "localhost";
}

module.exports = {
  user: "postgres",
  database: "postgres",
  password: "100329",
  host,
  port: 5432,
};
