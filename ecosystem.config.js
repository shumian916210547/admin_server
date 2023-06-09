module.exports = {
  apps: [
    {
      name: "admin_server",
      script: "app.js",
      watch: false,
      ignore_watch: ["node_modules", "logs", ".git", ".gitignore", "README.md", "resources"],
      env_development: {
        NODE_ENV: "development",
        npm_package_name: "admin_server",
        ParseHost: "http://localhost:3000/parse",
        ServerHost: "http://localhost:3000",
      },
      env_production: {
        NODE_ENV: "production",
        npm_package_name: "admin_server",
        ParseHost: "http://localhost:3000/parse",
        ServerHost: "http://localhost:3000",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
