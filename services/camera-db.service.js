"use strict";

const { Pool } = require("pg");
const { config } = require("../config/env");
const { HttpError } = require("../lib/http-error");
const logger = require("../lib/logger");

/** IPC 与 Parse 共用数据库，使用独立 Schema 和最多四条连接；SQL 均参数化。 */
const pool = new Pool({ connectionString: config.parse.databaseUri, max: 4, connectionTimeoutMillis: 5000 });

/**
 * 处理空闲数据库连接断开，避免 pg 的 error 事件终止整个 BFF。
 * @param {Error} error 必填，pg 连接错误；不输出可能含连接信息的消息或堆栈。
 * @returns {void} 写入脱敏可用性日志，后续请求由 query 返回 503。
 */
function handlePoolError(error) {
  logger.warn("camera.database_connection_lost", { reconnectOnNextRequest: true });
}

pool.on("error", handlePoolError);

/**
 * 执行 IPC 私有查询；不向浏览器泄露 SQL、数据库地址或凭据。
 * @param {string} sql 必填，固定 SQL 文本，值使用占位符。
 * @param {unknown[]} [values=[]] 可选，占位符参数。
 * @returns {Promise<import("pg").QueryResult>} 查询结果；写操作会修改 IPC 数据。
 * @throws {HttpError} 缺少迁移为 503，重复设备为 409，其余数据库故障为 503。
 */
async function query(sql, values = []) {
  try {
    return await pool.query(sql, values);
  } catch (error) {
    if (error.code === "23505") throw new HttpError(409, "CAMERA_DUPLICATE", "设备通道、组织编码、成员或视图名称重复");
    if (error.code === "23503") throw new HttpError(409, "CAMERA_REFERENCE", "组织不存在、跨企业或仍被下级节点、设备、成员引用");
    throw new HttpError(503, "CAMERA_DATABASE", "摄像头数据库不可用，请检查连接并执行 npm run migrate:camera");
  }
}

/**
 * 串行化同企业的组织结构和成员授权修改，避免并发移动形成循环或删除引用竞态。
 * @param {string} companyId 必填，可信会话的 Company ID，用于事务级锁。
 * @param {(client:import("pg").PoolClient)=>Promise<unknown>} work 必填，只能执行参数化 SQL 的事务处理器。
 * @returns {Promise<unknown>} 业务结果；失败回滚全部写入。
 * @throws {HttpError|Error} 授权/校验错误保持原义，约束错误转为 409，数据库连接失败为 503。
 */
async function transaction(companyId, work) {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`camera:${companyId}`]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    if (error instanceof HttpError) throw error;
    if (error.code === "23505") throw new HttpError(409, "CAMERA_DUPLICATE", "组织编码、成员或视图名称重复");
    if (error.code === "23503") throw new HttpError(409, "CAMERA_REFERENCE", "组织仍被引用或已被其他操作删除");
    throw new HttpError(503, "CAMERA_DATABASE", "摄像头数据库操作失败，请检查迁移与服务状态");
  } finally { client?.release(); }
}

module.exports = { query, pool, transaction };
