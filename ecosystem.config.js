module.exports = {
  apps: [
    {
      name: "admin_server",
      script: "app.js",
      watch: false,
      ignore_watch: ["node_modules", "logs"],
      env_development: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
        npm_package_name: "admin_server",
      },
      error_file: "./pm2logs/app-err.log",
      out_file: "./pm2logs/app-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
