module.exports = {
  apps: [
    {
      name: "admin_server",
      script: "app.js",
      watch: true,
      ignore_watch: ["node_modules", "logs"],
      env_dev: {
        NODE_ENV: "development",
      },
      env_prod: {
        NODE_ENV: "production",
      },
      error_file: "./pm2logs/app-err.log",
      out_file: "./pm2logs/app-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
