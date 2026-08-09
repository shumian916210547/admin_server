"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const ignored = new Set(["node_modules", ".git", "logs", "resources", "docs"]);
const checks = [
  { pattern: /masterKey\s*:\s*["'`]/, message: "Hard-coded Parse master key" },
  { pattern: /Parse\.masterKey\s*=\s*["'`]/, message: "Hard-coded Parse master key" },
  { pattern: /allowClientClassCreation\s*:\s*true/, message: "Client class creation enabled" },
  { pattern: /Access-Control-Allow-Origin["']?\s*:\s*["']\*["']/, message: "Wildcard CORS origin" },
  { pattern: /password\s*:\s*["']123456["']/, message: "Hard-coded default password" },
  { pattern: /sns\/jscode2session\?[^\n]*(?:appid|secret)=/i, message: "WeChat credentials embedded in URL" },
];

function filesIn(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) filesIn(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

const failures = [];
for (const file of filesIn(root)) {
  const source = fs.readFileSync(file, "utf8");
  for (const check of checks) {
    if (check.pattern.test(source)) failures.push(`${path.relative(root, file)}: ${check.message}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
