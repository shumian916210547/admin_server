"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const ignoredDirectories = new Set(["node_modules", ".git", "logs", "resources"]);

function collectJavaScriptFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) collectJavaScriptFiles(path.join(directory, entry.name), files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(directory, entry.name));
  }
  return files;
}

let failed = false;
for (const file of collectJavaScriptFiles(root)) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout || `Syntax error: ${file}\n`);
  }
}

if (failed) process.exitCode = 1;
