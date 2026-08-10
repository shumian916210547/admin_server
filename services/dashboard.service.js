const Parse = require("parse/node");
const { initializeParse } = require("./parse-runtime");

initializeParse();

const master = { useMasterKey: true };
const LOGIN_ACTIVITY_CLASS = "LoginActivity";
const ACTIVITY_LOOKBACK_DAYS = 30;
const ACTIVITY_QUERY_LIMIT = 1_000;
let schemaReadyPromise = null;

/**
 * 将任意日期转为 UTC 自然日键，避免服务器时区改变时把同一天的活动拆分到不同统计桶。
 * @param {Date | string | number} value 需要归类的时间值；无效值会回退到当前时间。
 * @returns {string} ISO 日期格式的 UTC 自然日键，例如 2026-08-09。
 */
function toUtcDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().slice(0, 10);
}

/**
 * 取得指定 UTC 自然日向前若干天的起始时间。
 * @param {Date} reference 统计基准时间，通常传入请求开始时的当前时间。
 * @param {number} daysAgo 向前回溯的天数，0 表示当日零点。
 * @returns {Date} UTC 零点时间对象。
 */
function utcDayStart(reference, daysAgo = 0) {
  const date = new Date(reference);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date;
}

/**
 * 生成连续自然日统计所需的日期键数组。
 * @param {Date} reference 统计基准时间。
 * @param {number} count 需要生成的自然日数量，最少为 1。
 * @returns {string[]} 从最早到最新排序的 UTC 日期键数组。
 */
function buildDayKeys(reference, count) {
  const safeCount = Math.max(Number(count) || 1, 1);
  return Array.from({ length: safeCount }, (_, index) =>
    toUtcDayKey(utcDayStart(reference, safeCount - index - 1))
  );
}

/**
 * 创建仅供 BFF 使用的登录活动 Schema。类级权限保持私有，避免它被低代码通用接口暴露。
 * @returns {Promise<void>} Schema 已存在或成功创建时完成；Parse 不可用时抛出异常。
 */
async function createLoginActivitySchema() {
  const schema = new Parse.Schema(LOGIN_ACTIVITY_CLASS);
  schema.addPointer("company", "Company");
  schema.addPointer("user", "_User");
  schema.addField("sessionId", "String");
  schema.setCLP(new Parse.CLP());
  await schema.save(master);
}

/**
 * 确保登录活动 Schema 已准备好，并兼容多进程首次登录时的并发建表竞争。
 * @returns {Promise<void>} 私有活动 Schema 可写可读时完成。
 */
async function ensureLoginActivitySchema() {
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    const schemas = await Parse.Schema.all(master);
    if (schemas.some((schema) => schema.className === LOGIN_ACTIVITY_CLASS)) return;

    try {
      await createLoginActivitySchema();
    } catch (error) {
      const refreshedSchemas = await Parse.Schema.all(master);
      const wasCreatedByAnotherWorker = refreshedSchemas.some(
        (schema) => schema.className === LOGIN_ACTIVITY_CLASS
      );
      if (!wasCreatedByAnotherWorker) throw error;
    }
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });

  return schemaReadyPromise;
}

/**
 * 创建当前用户、当前租户范围内的活动查询，防止指标服务绕开租户边界。
 * @param {{company: Parse.Object, user: Parse.Object}} auth 认证中间件提供的可信会话上下文。
 * @returns {Parse.Query} 已绑定 Company 与 _User 指针条件的 Parse 查询对象。
 */
function createActivityQuery(auth) {
  const query = new Parse.Query(LOGIN_ACTIVITY_CLASS);
  query.equalTo("company", auth.company);
  query.equalTo("user", auth.user);
  return query;
}

/**
 * 记录一次已经完成身份验证的登录，用于后续显示用户自己的登录趋势与活跃天数。
 * @param {{company: Parse.Object, user: Parse.Object}} auth 认证中间件提供的可信会话上下文。
 * @param {string} sessionId 当前 JWT 的 jti，仅用于匹配当前会话起点，不向浏览器返回。
 * @returns {Promise<void>} 记录成功写入后完成；写入失败时抛出异常供调用方降级处理。
 */
async function recordLoginActivity(auth, sessionId) {
  await ensureLoginActivitySchema();
  const LoginActivity = Parse.Object.extend(LOGIN_ACTIVITY_CLASS);
  const activity = new LoginActivity();
  activity.set("company", auth.company);
  activity.set("user", auth.user);
  activity.set("sessionId", sessionId);
  await activity.save(null, master);
}

/**
 * 按自然日统计一组登录记录，为首页七日趋势图提供稳定、有限的数据量。
 * @param {Parse.Object[]} activities 已按时间范围筛选的登录活动记录。
 * @param {Date} now 本次统计使用的统一当前时间。
 * @returns {Array<{date: string, label: string, count: number}>} 最近七日从早到晚的登录次数序列。
 */
function buildWeeklyActivity(activities, now) {
  const dayKeys = buildDayKeys(now, 7);
  const countByDay = activities.reduce((counts, activity) => {
    const key = toUtcDayKey(activity.createdAt);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());

  return dayKeys.map((date) => ({
    date,
    label: `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`,
    count: countByDay.get(date) || 0,
  }));
}

/**
 * 计算连续活跃自然日数量；当前已打开首页的日期视作活跃，以避免跨零点会话被错误中断。
 * @param {Set<string>} activeDayKeys 有登录记录的 UTC 自然日集合。
 * @param {Date} now 本次统计使用的统一当前时间。
 * @returns {number} 连续活跃天数，最小为 1。
 */
function calculateConsecutiveActiveDays(activeDayKeys, now) {
  const currentDayKey = toUtcDayKey(now);
  activeDayKeys.add(currentDayKey);
  let consecutiveDays = 0;

  for (let offset = 0; offset < ACTIVITY_LOOKBACK_DAYS; offset += 1) {
    const dayKey = toUtcDayKey(utcDayStart(now, offset));
    if (!activeDayKeys.has(dayKey)) break;
    consecutiveDays += 1;
  }

  return consecutiveDays;
}

/**
 * 获取当前用户可见的登录统计。接口只返回汇总值，不返回其他用户、IP 或会话凭据。
 * @param {{company: Parse.Object, user: Parse.Object, sessionId: string}} auth 认证中间件提供的可信会话上下文。
 * @returns {Promise<{totalLogins: number, loginToday: number, activeDaysLast30: number, consecutiveActiveDays: number, currentSessionStartedAt: string | null, lastLoginAt: string | null, weeklyActivity: Array<{date: string, label: string, count: number}>, loginDays: string[]}>} 首页仪表盘所需的脱敏统计数据。
 */
async function getDashboardOverview(auth) {
  await ensureLoginActivitySchema();
  const now = new Date();
  const firstDay = utcDayStart(now, ACTIVITY_LOOKBACK_DAYS - 1);
  const activityQuery = createActivityQuery(auth);
  activityQuery.greaterThanOrEqualTo("createdAt", firstDay);
  activityQuery.descending("createdAt");
  activityQuery.limit(ACTIVITY_QUERY_LIMIT);

  const totalQuery = createActivityQuery(auth);
  const [activities, totalLogins] = await Promise.all([activityQuery.find(master), totalQuery.count(master)]);
  const activeDayKeys = new Set(activities.map((activity) => toUtcDayKey(activity.createdAt)));
  const currentDayKey = toUtcDayKey(now);
  const currentSession = activities.find((activity) => activity.get("sessionId") === auth.sessionId);
  const latestActivity = activities[0];
  const weeklyActivity = buildWeeklyActivity(activities, now);
  const loginDays = [...new Set(activities.map((activity) => toUtcDayKey(activity.createdAt)))].sort();

  activeDayKeys.add(currentDayKey);
  return {
    totalLogins,
    loginToday: weeklyActivity.at(-1)?.count || 0,
    activeDaysLast30: activeDayKeys.size,
    consecutiveActiveDays: calculateConsecutiveActiveDays(activeDayKeys, now),
    currentSessionStartedAt: currentSession?.createdAt?.toISOString?.() || null,
    lastLoginAt: latestActivity?.createdAt?.toISOString?.() || null,
    weeklyActivity,
    loginDays,
  };
}

module.exports = {
  getDashboardOverview,
  recordLoginActivity,
};
