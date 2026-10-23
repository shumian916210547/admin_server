"use strict";

const crypto = require("crypto");
const Parse = require("parse/node");
const db = require("./camera-db.service");
const access = require("./camera-access.service");
const { master, pointer } = require("./parse-data.service");
const { badRequest, forbidden, notFound } = require("../lib/http-error");

/** 组织类型按业务顺序定义；公司只能是根，门店不能再有子节点。 */
const types = ["company", "organization", "store"];

/**
 * 在当前事务内追加摄像头操作审计，只写明确的目标和摘要，不接收任意请求体或设备凭据。
 * @param {object} client 必填，pg 事务客户端或本领域 db 查询器。
 * @param {object} auth 必填，可信 companyId/userId。
 * @param {string} action 必填，服务端固定动作代码。
 * @param {string} target 必填，目标 UUID/成员标识。
 * @param {string} summary 必填，最多 500 字符的非敏感中文摘要。
 * @returns {Promise<void>} 追加审计，并将每个企业的历史上限控制为 10000 条。
 */
async function audit(client, auth, action, target, summary) {
  await client.query("INSERT INTO camera.audit(id,company_id,actor_id,action,target_id,summary) VALUES($1,$2,$3,$4,$5,$6)", [crypto.randomUUID(), auth.companyId, auth.userId, action, target, summary.slice(0, 500)]);
  await client.query("DELETE FROM camera.audit WHERE company_id=$1 AND id IN (SELECT id FROM camera.audit WHERE company_id=$1 ORDER BY created_at DESC OFFSET 10000)", [auth.companyId]);
}

/**
 * 返回各页面共用的可见组织树、组织统计和独立页面操作权限，不向范围外成员返回组织名称。
 * @param {object} auth 必填，可信会话。
 * @returns {Promise<object>} tree、organizations、permissions 及未归属设备数量。
 * @throws {HttpError} 没有任一视频页面查询权限或数据库不可用时拒绝。
 */
async function overview(auth) {
  await access.authorizeRead(auth);
  const context = await access.scope(auth);
  const rows = context.ids ? context.rows.filter((row) => context.ids.includes(row.id)) : context.rows;
  const counts = (await db.query("SELECT organization_id,count(*)::int AS count FROM camera.devices WHERE company_id=$1 GROUP BY organization_id", [auth.companyId])).rows;
  const organizations = rows.map((row) => ({ ...row, deviceCount: counts.find((item) => item.organization_id === row.id)?.count || 0 }));
  return {
    organizations,
    tree: access.tree(organizations),
    permissions: await access.permissions(auth, "CameraOrganization"),
    memberPermissions: auth.isAdmin ? await access.permissions(auth, "CameraMember") : { query: true, insert: false, edit: false, remove: false },
    unassignedCount: auth.isAdmin ? counts.find((item) => !item.organization_id)?.count || 0 : 0,
    canCreateAccount: Boolean(auth.isAdmin),
  };
}

/**
 * 新建/修改组织，事务串行验证父类型、循环、下级兼容性和同租户唯一编码。
 * @param {object} auth 必填，可信会话。
 * @param {object} input 必填，name/type/parentId/code/rank/isActive/remark。
 * @param {string} [organizationId] 可选，修改目标 UUID；缺省新建。
 * @returns {Promise<object>} 已保存组织；写组织和审计。
 * @throws {HttpError} 参数无效、移动越权、循环或仍有不兼容子节点时 400/404/409。
 */
async function saveOrganization(auth, input, organizationId) {
  await access.authorize(auth, "CameraOrganization", organizationId ? "edit" : "insert");
  const context = await access.scope(auth);
  const targetId = organizationId ? access.id(organizationId) : crypto.randomUUID();
  const name = access.text(input?.name, "组织名称", 100, true);
  const type = input?.type;
  if (!types.includes(type)) throw badRequest("组织类型必须是公司、组织或门店");
  const parentId = input.parentId ? access.id(input.parentId) : null;
  if (!Number.isInteger(input.rank) || Math.abs(input.rank) > 100000) throw badRequest("排序必须是 -100000 至 100000 的整数");
  if (typeof input.isActive !== "boolean") throw badRequest("组织状态必须为布尔值");
  if (!auth.isAdmin && (!parentId || (organizationId && !context.ids.includes(targetId)) || !context.ids.includes(parentId))) throw forbidden("只能维护已授权的视频组织及其下级");
  return db.transaction(auth.companyId, async (client) => {
    const rows = (await client.query("SELECT * FROM camera.organizations WHERE company_id=$1", [auth.companyId])).rows;
    const previous = rows.find((row) => row.id === targetId);
    if (organizationId && !previous) throw notFound("视频组织不存在");
    if (!organizationId && rows.length >= 5000) throw badRequest("每企业最多 5000 个视频组织节点");
    const parent = rows.find((row) => row.id === parentId);
    if (type === "company" ? Boolean(parentId) : !parent || parent.type === "store" || (type === "store" && parent.type !== "organization")) throw badRequest("公司只能作为根节点，组织归属公司或组织，门店必须归属组织");
    if (parent && !parent.is_active) throw badRequest("不能分配到已停用的上级组织");
    const visited = new Set([targetId]);
    let current = parent;
    while (current) {
      if (visited.has(current.id)) throw badRequest("不能将组织移动到自身或其下级");
      visited.add(current.id);
      current = rows.find((row) => row.id === current.parent_id);
    }
    const children = rows.filter((row) => row.parent_id === targetId);
    if ((type === "store" && children.length) || (type === "company" && children.some((row) => row.type !== "organization"))) throw badRequest("现有子节点与新的组织类型不兼容，请先移动子节点");
    const values = [targetId, auth.companyId, name, type, parentId, access.text(input.code, "组织编码", 64), input.rank, input.isActive, access.text(input.remark, "备注", 500)];
    const sql = previous
      ? "UPDATE camera.organizations SET name=$3,type=$4,parent_id=$5,code=$6,rank=$7,is_active=$8,remark=$9,updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING *"
      : "INSERT INTO camera.organizations(id,company_id,name,type,parent_id,code,rank,is_active,remark) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *";
    const result = (await client.query(sql, values)).rows[0];
    await audit(client, auth, previous ? "organization.update" : "organization.create", targetId, `${previous ? "修改" : "新增"}视频组织：${name}`);
    return result;
  });
}

/**
 * 删除无子节点、设备或成员引用的组织，复合外键同时防止并发引用与跨企业引用。
 * @param {object} auth 必填，可信会话。
 * @param {string} organizationId 必填，组织 UUID。
 * @returns {Promise<void>} 删除组织并写审计；不级联删除设备和成员。
 * @throws {HttpError} 越权/不存在为 404，被引用为 409。
 */
async function removeOrganization(auth, organizationId) {
  await access.authorize(auth, "CameraOrganization", "remove");
  const row = await access.organization(auth, organizationId);
  await db.transaction(auth.companyId, async (client) => {
    await client.query("DELETE FROM camera.organizations WHERE id=$1 AND company_id=$2", [row.id, auth.companyId]);
    await audit(client, auth, "organization.remove", row.id, `删除空视频组织：${row.name}`);
  });
}

/**
 * 批量调整最多 100 台设备的归属，先校验全部目标，保证全成全败并记录审计。
 * @param {object} auth 必填，可信会话。
 * @param {object} input 必填，deviceIds UUID 数组、organizationId 目标组织。
 * @returns {Promise<object>} 更新数量；修改设备归属，后续媒体请求按新范围校验。
 * @throws {HttpError} 范围外设备、跨企业组织或参数无效时拒绝。
 */
async function assignDevices(auth, input) {
  await access.authorize(auth, "CameraDevice", "edit");
  if (!Array.isArray(input?.deviceIds) || !input.deviceIds.length || input.deviceIds.length > 100) throw badRequest("每次请选择 1 至 100 个设备");
  const ids = [...new Set(input.deviceIds.map(access.id))];
  const organization = await access.organization(auth, input.organizationId, true);
  const scope = await access.scope(auth);
  return db.transaction(auth.companyId, async (client) => {
    const rows = (await client.query("SELECT id,organization_id FROM camera.devices WHERE company_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE", [auth.companyId, ids])).rows;
    if (rows.length !== ids.length || (scope.ids && rows.some((row) => !scope.ids.includes(row.organization_id)))) throw notFound("部分设备不存在或不在当前授权范围内");
    await client.query("UPDATE camera.devices SET organization_id=$3,updated_at=now() WHERE company_id=$1 AND id=ANY($2::uuid[])", [auth.companyId, ids, organization.id]);
    await audit(client, auth, "device.assign", organization.id, `将 ${ids.length} 台设备归属至 ${organization.name}`);
    return { count: ids.length };
  });
}

/**
 * 查询可见的摄像头成员并从平台账号读取脱敏资料；返回值不包含密码或会话字段。
 * @param {object} auth 必填，可信会话。
 * @returns {Promise<object>} members 列表；普通成员仅见授权范围内的成员。
 * @throws {HttpError} 未授权或数据源失败时拒绝。
 */
async function members(auth) {
  await access.authorize(auth, "CameraMember");
  const context = await access.scope(auth);
  const rows = (await db.query("SELECT m.*,o.name AS organization_name FROM camera.members m JOIN camera.organizations o ON o.id=m.organization_id AND o.company_id=m.company_id WHERE m.company_id=$1 ORDER BY m.created_at DESC LIMIT 2000", [auth.companyId])).rows.filter((row) => !context.ids || context.ids.includes(row.organization_id));
  const users = new Parse.Query(Parse.User);
  users.equalTo("company", pointer("Company", auth.companyId));
  users.containedIn("objectId", rows.map((row) => row.user_id));
  users.select("username", "name", "isDelete");
  users.limit(2000);
  const records = await users.find(master);
  return { members: rows.map((row) => { const user = records.find((item) => item.id === row.user_id); return { ...row, username: user?.get("username") || "账号已移除", name: user?.get("name") || "", accountActive: Boolean(user && !user.get("isDelete")) }; }) };
}

/**
 * 仅平台管理员搜索同租户可关联账号，关键词最多 64 字符，每次返回最多 100 条。
 * @param {object} auth 必填，可信会话。
 * @param {unknown} keyword 可选，用户名/姓名包含文本，不执行正则。
 * @returns {Promise<object[]>} userId、username、name 安全选项。
 * @throws {HttpError} 非管理员或无新增成员权限为 403。
 */
async function memberOptions(auth, keyword) {
  await access.authorize(auth, "CameraMember", "insert");
  if (!auth.isAdmin) throw forbidden("仅系统管理员可关联企业账号");
  const word = access.text(keyword, "成员关键词", 64);
  const username = new Parse.Query(Parse.User).contains("username", word);
  const name = new Parse.Query(Parse.User).contains("name", word);
  const query = Parse.Query.or(username, name);
  query.equalTo("company", pointer("Company", auth.companyId));
  query.notEqualTo("isDelete", true);
  query.select("username", "name");
  query.limit(100);
  return (await query.find(master)).map((user) => ({ userId: user.id, username: user.get("username"), name: user.get("name") || "" }));
}

/**
 * 创建专供视频中心使用的最低权限岗位，保持已有账号的岗位不变。
 * @param {object} auth 必填，已经验证为平台管理员的可信会话。
 * @returns {Promise<Parse.Object>} 同租户的视频查看岗位；必要时写 Role/AllotPermission。
 * @throws {HttpError} 独立模块尚未初始化时 400。
 */
async function viewerRole(auth) {
  const route = await new Parse.Query("Route").equalTo("company", pointer("Company", auth.companyId)).equalTo("systemKey", "camera.video").first(master);
  if (!route) throw badRequest("请先刷新管理员菜单初始化摄像头独立模块");
  const query = new Parse.Query("Role").equalTo("company", pointer("Company", auth.companyId)).equalTo("systemKey", "camera.viewer");
  let role = await query.first(master);
  if (!role) {
    role = new Parse.Object("Role");
    await role.save({ company: pointer("Company", auth.companyId), systemKey: "camera.viewer", name: "视频查看成员", positionManaged: true, module: [pointer("Route", route.id)] }, master);
  }
  const existingPermission = await new Parse.Query("AllotPermission").equalTo("company", pointer("Company", auth.companyId)).equalTo("role", pointer("Role", role.id)).first(master);
  if (!existingPermission) {
    const permission = new Parse.Object("AllotPermission");
    await permission.save({ company: pointer("Company", auth.companyId), role: pointer("Role", role.id), routes: [pointer("Route", route.id)], positionManaged: true, permissions: ["permission:query"], routePermissions: { [route.id]: ["permission:query"] } }, master);
  }
  return role;
}

/**
 * 新增或修改摄像头成员归属；可由平台管理员创建仅含视频查看岗位的新账号，或关联现有账号。
 * @param {object} auth 必填，可信会话，写成员仅允许平台管理员。
 * @param {object} input 必填，userId 或 account{username,password,name}，organizationId/includeDescendants/isActive/remark。
 * @param {string} [memberId] 可选，修改的成员 UUID；编辑不允许换绑账号。
 * @returns {Promise<object>} 脱敏成员关系；新账号失败时补偿删除，不影响现有账号。
 * @throws {HttpError} 账号跨企业、范围无效、重复关系或密码不合规时拒绝。
 */
async function saveMember(auth, input, memberId) {
  await access.authorize(auth, "CameraMember", memberId ? "edit" : "insert");
  if (!auth.isAdmin) throw forbidden("仅系统管理员可调整视频成员授权");
  const organization = await access.organization(auth, input?.organizationId, true);
  if (typeof input.includeDescendants !== "boolean" || typeof input.isActive !== "boolean") throw badRequest("成员状态和下级范围必须为布尔值");
  const id = memberId ? access.id(memberId) : crypto.randomUUID();
  let createdUser;
  let user;
  try {
    if (input.account && !memberId) {
      const username = access.text(input.account.username, "登录账号", 64, true);
      const password = input.account.password;
      if (typeof password !== "string" || password.length < 12 || password.length > 256) throw badRequest("初始密码长度应为 12 至 256 个字符");
      const role = await db.transaction(auth.companyId, () => viewerRole(auth));
      user = new Parse.User();
      await user.signUp({ username, password, name: access.text(input.account.name, "姓名", 100), company: pointer("Company", auth.companyId), role: pointer("Role", role.id), isDelete: false }, master);
      createdUser = user;
    } else {
      const userId = access.text(input.userId, "成员账号", 128, true);
      user = await new Parse.Query(Parse.User).equalTo("company", pointer("Company", auth.companyId)).equalTo("objectId", userId).first(master);
      if (!user || user.get("isDelete")) throw badRequest("成员账号不存在、已停用或不属于当前企业");
    }
    return await db.transaction(auth.companyId, async (client) => {
      if (!memberId && Number((await client.query("SELECT count(*) FROM camera.members WHERE company_id=$1", [auth.companyId])).rows[0].count) >= 2000) throw badRequest("每企业最多关联 2000 个视频成员");
      if (memberId) {
        const previous = (await client.query("SELECT * FROM camera.members WHERE id=$1 AND company_id=$2 FOR UPDATE", [id, auth.companyId])).rows[0];
        if (!previous || previous.user_id !== user.id) throw notFound("成员不存在或不允许换绑账号");
      }
      const values = [id, auth.companyId, user.id, organization.id, input.includeDescendants, input.isActive, access.text(input.remark, "备注", 500)];
      const sql = memberId
        ? "UPDATE camera.members SET organization_id=$4,include_descendants=$5,is_active=$6,remark=$7,updated_at=now() WHERE id=$1 AND company_id=$2 AND user_id=$3 RETURNING *"
        : "INSERT INTO camera.members(id,company_id,user_id,organization_id,include_descendants,is_active,remark) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *";
      const result = (await client.query(sql, values)).rows[0];
      await audit(client, auth, memberId ? "member.update" : "member.create", id, `${memberId ? "调整" : "新增"}视频成员组织归属：${organization.name}`);
      return result;
    });
  } catch (error) {
    if (createdUser) await createdUser.destroy(master);
    if (error.code === 202) throw badRequest("该登录账号已存在，请使用关联现有账号");
    throw error;
  }
}

/**
 * 删除视频成员关系，立即撤销组织访问但保留平台账号，避免误删其他业务成员。
 * @param {object} auth 必填，可信平台管理员会话。
 * @param {string} memberId 必填，成员关系 UUID。
 * @returns {Promise<void>} 删除视频授权并记录审计；不会删除平台用户。
 * @throws {HttpError} 无 remove 权限或目标跨租户时拒绝。
 */
async function removeMember(auth, memberId) {
  await access.authorize(auth, "CameraMember", "remove");
  if (!auth.isAdmin) throw forbidden("仅系统管理员可删除视频成员授权");
  await db.transaction(auth.companyId, async (client) => {
    const result = await client.query("DELETE FROM camera.members WHERE id=$1 AND company_id=$2 RETURNING id", [access.id(memberId), auth.companyId]);
    if (!result.rows.length) throw notFound("视频成员不存在");
    await audit(client, auth, "member.remove", memberId, "删除视频成员组织授权，保留平台账号");
  });
}

/**
 * 读取当前管理员的最新 100 条视频模块审计，避免向普通成员暴露其他组织操作。
 * @param {object} auth 必填，可信会话。
 * @returns {Promise<object[]>} 不含凭据的审计记录，最新优先。
 * @throws {HttpError} 非系统管理员时 403。
 */
async function activity(auth) {
  await access.authorizeRead(auth);
  if (!auth.isAdmin) throw forbidden("仅系统管理员可查看视频操作审计");
  return (await db.query("SELECT id,action,target_id,summary,created_at FROM camera.audit WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100", [auth.companyId])).rows;
}

/**
 * 列出个人监控视图，按当前组织权限实时裁剪设备 ID；权限撤销后旧视图不能恢复越权画面。
 * @param {object} auth 必填，可信会话，仅当前 userId 的视图可见。
 * @returns {Promise<object[]>} 视图名称、1–16 分屏数与已裁剪的设备 ID/null 槽位。
 * @throws {HttpError} 没有视频中心权限或数据库不可用时拒绝。
 */
async function views(auth) {
  await access.authorize(auth, "CameraVideo");
  const scope = await access.scope(auth);
  const devices = (await db.query("SELECT id,organization_id FROM camera.devices WHERE company_id=$1", [auth.companyId])).rows.filter((row) => !scope.ids || scope.ids.includes(row.organization_id));
  const allowed = new Set(devices.map((row) => row.id));
  const rows = (await db.query("SELECT id,name,screens,devices,updated_at FROM camera.views WHERE company_id=$1 AND user_id=$2 ORDER BY updated_at DESC LIMIT 20", [auth.companyId, auth.userId])).rows;
  return rows.map((row) => ({ ...row, devices: row.devices.map((id) => allowed.has(id) ? id : null) }));
}

/**
 * 保存个人分屏视图，不保存播放 URL、密码或媒体会话；同名视图显式覆盖，最多 20 个。
 * @param {object} auth 必填，可信 companyId/userId。
 * @param {object} input 必填，name/screen 数量 screens 1–16、devices 为不超过屏数的 UUID/null 数组。
 * @returns {Promise<object>} 已保存视图 ID；写个人视图。
 * @throws {HttpError} 参数、设备权限或视图数量无效时拒绝。
 */
async function saveView(auth, input) {
  await access.authorize(auth, "CameraVideo");
  const name = access.text(input?.name, "视图名称", 100, true);
  if (!Number.isInteger(input.screens) || input.screens < 1 || input.screens > 16 || !Array.isArray(input.devices) || input.devices.length > input.screens) throw badRequest("监控视图必须为 1 至 16 分屏，设备不能超出槽位数量");
  const scope = await access.scope(auth);
  const ids = input.devices.map((value) => value === null ? null : access.id(value));
  const records = (await db.query("SELECT id,organization_id FROM camera.devices WHERE company_id=$1 AND id=ANY($2::uuid[])", [auth.companyId, ids.filter(Boolean)])).rows;
  for (const id of ids.filter(Boolean)) {
    const row = records.find((item) => item.id === id);
    if (!row || (scope.ids && !scope.ids.includes(row.organization_id))) throw notFound("视图中包含不可访问的设备");
  }
  return db.transaction(auth.companyId, async (client) => {
    const existing = (await client.query("SELECT id FROM camera.views WHERE company_id=$1 AND user_id=$2 AND name=$3", [auth.companyId, auth.userId, name])).rows[0];
    if (!existing && Number((await client.query("SELECT count(*) FROM camera.views WHERE company_id=$1 AND user_id=$2", [auth.companyId, auth.userId])).rows[0].count) >= 20) throw badRequest("个人监控视图最多保存 20 个，请先删除不需要的视图");
    return (await client.query("INSERT INTO camera.views(id,company_id,user_id,name,screens,devices) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,user_id,name) DO UPDATE SET screens=$5,devices=$6,updated_at=now() RETURNING id", [existing?.id || crypto.randomUUID(), auth.companyId, auth.userId, name, input.screens, JSON.stringify(ids)])).rows[0];
  });
}

/**
 * 删除当前用户自己的监控视图，不影响视频设备或其他成员视图。
 * @param {object} auth 必填，可信会话。
 * @param {string} viewId 必填，视图 UUID。
 * @returns {Promise<void>} 幂等删除；需前端中文二次确认。
 */
async function removeView(auth, viewId) {
  await access.authorize(auth, "CameraVideo");
  await db.query("DELETE FROM camera.views WHERE id=$1 AND company_id=$2 AND user_id=$3", [access.id(viewId), auth.companyId, auth.userId]);
}

module.exports = { overview, saveOrganization, removeOrganization, assignDevices, members, memberOptions, saveMember, removeMember, activity, audit, views, saveView, removeView };
