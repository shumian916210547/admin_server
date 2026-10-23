"use strict";

const fs = require("fs/promises");
const path = require("path");
const { pool } = require("../services/camera-db.service");

/**
 * 在受控终端幂等创建 IPC 私有 Schema；无参数，不修改现有业务表。
 * @returns {Promise<void>} 完成后关闭连接；失败设置非零退出码，不输出数据库机密。
 */
async function main() {
  try {
    const directory = path.join(__dirname, "../migrations/camera");
    const migrations = (await fs.readdir(directory)).filter((name) => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
    for (const filename of migrations) await pool.query(await fs.readFile(path.join(directory, filename), "utf8"));
    process.stdout.write("摄像头数据库迁移完成\n");
  } catch {
    process.stderr.write("摄像头数据库迁移失败，请检查数据库连接与建表权限\n");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
