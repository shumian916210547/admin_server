"use strict";

const fs = require("fs");
const path = require("path");

const { closeCollabPool, getCollabPool } = require("../services/collab-database.service");

const migrationDirectory = path.resolve(__dirname, "../migrations/collab");

/**
 * 读取按文件名排序的协同数据库迁移脚本，拒绝执行目录之外的任意文件。
 * @returns {Array<{version: string, sql: string}>} 待检查的迁移版本及 SQL 内容。
 * @throws {Error} 迁移目录不可读、文件名不符合约定或脚本为空时抛出。
 */
function loadMigrations() {
  return fs
    .readdirSync(migrationDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{3}_[a-z0-9_-]+\.sql$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      version: entry.name,
      sql: fs.readFileSync(path.join(migrationDirectory, entry.name), "utf8").trim(),
    }))
    .filter((migration) => migration.sql);
}

/**
 * 在协同数据库中按版本幂等执行所有迁移；每个迁移和版本登记在同一事务内提交。
 * @returns {Promise<{applied: string[], skipped: string[]}>} 本次新增执行和已存在的迁移版本。
 * @throws {Error} 数据库连接、事务或 SQL 迁移失败时回滚并抛出。
 */
async function migrateCollab() {
  const pool = getCollabPool();
  const client = await pool.connect();
  const applied = [];
  const skipped = [];
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE SCHEMA IF NOT EXISTS collab; CREATE TABLE IF NOT EXISTS collab.schema_migrations (version varchar(128) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    for (const migration of loadMigrations()) {
      const result = await client.query(
        "SELECT 1 FROM collab.schema_migrations WHERE version = $1",
        [migration.version]
      );
      if (result.rowCount) {
        skipped.push(migration.version);
        continue;
      }
      await client.query(migration.sql);
      await client.query("INSERT INTO collab.schema_migrations (version) VALUES ($1)", [migration.version]);
      applied.push(migration.version);
    }
    await client.query("COMMIT");
    return { applied, skipped };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 作为 npm 脚本入口运行协同迁移，并以 JSON 输出不含数据库凭据的执行摘要。
 * @returns {Promise<void>} 迁移完成后兑现；失败时设置非零进程退出码。
 */
async function main() {
  const result = await migrateCollab();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * 运行协同迁移并在成功或失败后关闭 PostgreSQL 连接池，避免 CLI 被空闲连接拖住。
 * @returns {Promise<void>} 迁移和连接池清理完成后兑现；迁移或清理失败时设置非零退出码。
 */
async function run() {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    await closeCollabPool().catch((error) => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    });
  }
}

run();
