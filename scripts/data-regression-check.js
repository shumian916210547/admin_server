"use strict";

// 保留真实 Parse Query 编码器；只替换数据库传输和运行时初始化，不读取 .env 或写数据库。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const Parse = require("parse/node");
const filename = path.resolve(__dirname, "../services/parse-data.service.js");
const requireService = createRequire(filename);
const queries = [];
let savedDate;
Parse.Schema.all = async () => [{ className: "RegressionRecord", fields: { at: { type: "Date" }, title: { type: "String" } } },
  { className: "_User", fields: { at: { type: "Date" } } }];
/** @returns {Promise<Array>} 记录真实 Query 编码结果，返回空数据，不执行网络请求。 */
Parse.Query.prototype.find = async function () { queries.push(this.toJSON()); return []; };
Parse.Query.prototype.count = async function () { return 0; };
/** @returns {Promise<Parse.Object>} 截获写入的 Date 值；只更新内存对象 ID。 */
Parse.Object.prototype.save = async function () { savedDate = this.get("at"); this.id = "saved"; return this; };
const loaded = { exports: {} };
/** @param {string} id 必填，服务依赖标识。 @returns {object} 真实模块或隔离运行时替身。 */
function resolveImport(id) {
  if (id === "./parse-runtime") return { initializeParse() {} };
  if (id === "./organization.service") return { ORGANIZATION_CLASS: "Organization", resolveAccessibleOrganizationIds: async () => null };
  return requireService(id);
}
new Function("require", "module", "exports", fs.readFileSync(filename, "utf8"))(resolveImport, loaded, loaded.exports);

/** @returns {Promise<void>} 验证真实 Parse 日期编码及租户交集；失败退出非零，没有持久化副作用。 */
async function main() {
  const { queryRecords, createRecord } = loaded.exports;
  const auth = { isAdmin: true, companyId: "tenant-a", userId: "member-a" };
  const date = { __type: "Date", iso: "2026-11-01T00:00:00.000Z" };
  await queryRecords(auth, { className: "RegressionRecord", filters: [
    { field: "company", operator: "equalTo", value: "tenant-b" },
    { field: "at", operator: "greaterThanOrEqualTo", value: date },
    { field: "at", operator: "lessThanOrEqualTo", value: { ...date, iso: "2026-11-02T00:00:00.000Z" } },
  ] });
  const encoded = JSON.stringify(queries.at(-1).where);
  assert(encoded.includes('"$gte":{"__type":"Date"'));
  assert(encoded.includes('"$lte":{"__type":"Date"'));
  assert(encoded.includes("tenant-a"));
  assert(!encoded.includes("tenant-b"));
  console.log("PASS 日期区间正确编码且客户端 company 无法替换服务端租户");

  await createRecord(auth, "RegressionRecord", { at: date, title: "回归测试" });
  assert(savedDate instanceof Date);
  assert.equal(savedDate.toISOString(), date.iso);
  console.log("PASS Parse 写入获得 Date 实例而非空对象或普通 JSON");

  await assert.rejects(queryRecords(auth, { className: "RegressionRecord", filters: [
    { field: "title", operator: "greaterThanOrEqualTo", value: date },
  ] }), (error) => error.status === 400);
  await assert.rejects(queryRecords(auth, { className: "RegressionRecord", filters: [
    { field: "at", operator: "equalTo", value: { __type: "Date", iso: "invalid" } },
  ] }), (error) => error.status === 400);
  await assert.rejects(queryRecords(auth, { className: "RegressionRecord", filters: [
    { field: "at", operator: "$where", value: "invalid" },
  ] }), (error) => error.status === 400);
  console.log("PASS 错误日期、非日期区间与未知运算符均被拒绝");

  await queryRecords({ ...auth, isAdmin: false }, { className: "_User", filters: [
    { field: "objectId", operator: "equalTo", value: "member-b" },
    { field: "at", operator: "greaterThanOrEqualTo", value: date },
  ] });
  const scoped = JSON.stringify(queries.at(-1).where);
  assert(scoped.includes("member-a") && scoped.includes("member-b") && scoped.includes('"$and"'));
  console.log("PASS 新日期条件仍与当前用户范围取交集，不能覆盖授权条件");

  require("parse-server");
  const { makeExecutableSchema } = require("@graphql-tools/schema");
  const { graphql } = require("graphql");
  const schema = makeExecutableSchema({ typeDefs: "type Query { ready: Boolean! }", resolvers: { Query: { ready: () => true } } });
  const result = await graphql({ schema, source: "{ ready }" });
  assert.equal(result.data?.ready, true);
  assert.equal(result.errors, undefined);
  console.log("PASS 安全依赖更新后 Parse Server 加载与 GraphQL Schema/查询兼容");
  for (const parent of ["google-gax", "teeny-request"]) {
    const fromParent = createRequire(require.resolve(parent));
    assert.match(fromParent("uuid").v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    require(parent);
  }
  console.log("PASS Google/Firebase 推送依赖使用修复后的 UUID，保留 CommonJS v4 调用兼容性");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
