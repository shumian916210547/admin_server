"use strict";

const { Pool } = require("pg");

const { config } = require("../config/env");
const { HttpError } = require("../lib/http-error");

let pool;

/**
 * 返回协同领域使用的 PostgreSQL 连接池；默认复用 DATABASE_URI，也可通过独立 URI 隔离账号和数据库。
 * @returns {import("pg").Pool} 协同数据库连接池。
 * @throws {Error} 连接池配置无法创建时抛出。
 */
function getCollabPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.collab.databaseUri,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "shumian-collab",
    });
  }
  return pool;
}

/**
 * 判断数据库错误是否表示协同迁移尚未执行，以便 API 返回可操作的服务状态而不是泄露 SQL 细节。
 * @param {unknown} error pg 抛出的数据库错误。
 * @returns {boolean} 缺少 collab 表、Schema 或数据库对象时返回 true。
 */
function isCollabSchemaError(error) {
  return error?.code === "42P01" || error?.code === "3F000" || error?.code === "42704";
}

/**
 * 将协同数据库不可用错误转换成稳定的业务错误；其他错误原样交给统一日志中间件处理。
 * @param {unknown} error 原始数据库错误或已规范化的 HttpError。
 * @returns {Error} 可安全返回给浏览器的错误或原始错误。
 */
function normalizeCollabDatabaseError(error) {
  if (error instanceof HttpError) return error;
  if (isCollabSchemaError(error)) {
    return new HttpError(503, "COLLAB_DATABASE_NOT_READY", "协同表格服务尚未完成数据库迁移");
  }
  if (error?.code === "57P01" || error?.code === "ECONNREFUSED" || error?.code === "ETIMEDOUT") {
    return new HttpError(503, "COLLAB_DATABASE_UNAVAILABLE", "协同表格服务暂时不可用");
  }
  return error;
}

/**
 * 执行一条协同数据库查询，并在连接或迁移状态异常时返回稳定的服务错误。
 * @param {string} text 参数化 SQL 文本，禁止拼接客户端字段值。
 * @param {unknown[]} [params=[]] SQL 占位符参数数组。
 * @returns {Promise<import("pg").QueryResult>} PostgreSQL 查询结果。
 * @throws {Error} 数据库不可用、迁移缺失或 SQL 执行失败时抛出。
 */
async function queryCollab(text, params = []) {
  try {
    return await getCollabPool().query(text, params);
  } catch (error) {
    throw normalizeCollabDatabaseError(error);
  }
}

/**
 * 在协同数据库事务中执行多项写操作，保证版本递增、快照引用和审计事件一起提交。
 * @param {(client: import("pg").PoolClient) => Promise<unknown>} callback 接收事务客户端并执行参数化查询的异步函数。
 * @returns {Promise<unknown>} callback 的返回值。
 * @throws {Error} BEGIN、业务查询、COMMIT 或回滚失败时抛出；未提交写入不会对外可见。
 */
async function withCollabTransaction(callback) {
  const client = await getCollabPool().connect().catch((error) => {
    throw normalizeCollabDatabaseError(error);
  });
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw normalizeCollabDatabaseError(error);
  } finally {
    client.release();
  }
}

/**
 * 检查协同领域初始表是否已经完成迁移，供健康检查或首次 API 调用使用。
 * @returns {Promise<void>} collab.documents 存在时兑现。
 * @throws {import("../lib/http-error").HttpError} 数据库未迁移或暂时不可用时抛出 503。
 */
async function assertCollabDatabaseReady() {
  const result = await queryCollab("SELECT to_regclass('collab.documents') AS table_name");
  if (!result.rows[0]?.table_name) {
    throw new HttpError(503, "COLLAB_DATABASE_NOT_READY", "协同表格服务尚未完成数据库迁移");
  }
}

/**
 * 关闭协同数据库连接池，供受控测试或进程优雅退出时释放连接。
 * @returns {Promise<void>} 连接池关闭完成后兑现；未创建连接池时不执行操作。
 * @throws {Error} PostgreSQL 关闭连接失败时抛出。
 */
async function closeCollabPool() {
  if (!pool) return;
  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}

module.exports = {
  getCollabPool,
  queryCollab,
  withCollabTransaction,
  assertCollabDatabaseReady,
  closeCollabPool,
  isCollabSchemaError,
};
