let host = "114.215.210.204";

/* if (process.env.NODE_ENV == "development") {
  host = "localhost";
}

if (process.env.NODE_ENV == "production") {
  host = "114.215.210.204";
} */

module.exports = {
  user: "postgres",
  database: "postgres",
  password: "100329",
  port: 5432,
  host,
};
