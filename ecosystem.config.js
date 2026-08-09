module.exports = {
  apps: [
    {
      name: "admin_server",
      script: "app.js",
      watch: false,
      ignore_watch: ["node_modules", "logs", ".git", "resources"],
      env_development: { NODE_ENV: "development" },
      env_production: { NODE_ENV: "production" },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
