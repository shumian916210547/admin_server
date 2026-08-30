# 安全架构与运维说明

## 目标架构

```mermaid
flowchart LR
  Browser["Vue 管理端"] -->|"HTTPS /api\nHttpOnly Cookie + CSRF"| BFF["Express BFF\n认证、RBAC、租户边界、上传校验"]
  BFF -->|"localhost only\nMaster Key"| Parse["Parse Server\n内部数据引擎"]
  Parse --> PostgreSQL["PostgreSQL"]
  BFF -->|"参数化 SQL"| CollabDB[("PostgreSQL collab Schema")]
  BFF -->|"受控随机对象键"| CollabFiles["协同文件存储"]
  BFF -. "可选、短时 JWT" .-> Office["ONLYOFFICE Document Server"]
  Admin["受控运维终端"] -. "SSH / 私网" .-> Parse
```

浏览器不再访问 `/parse`、Parse Dashboard 或数据库；`PARSE_MASTER_KEY`、数据库 URI 和 JWT 密钥只存在于服务端 `.env`。

## 已消除的主要风险

| 原问题 | 风险 | 当前控制措施 |
| --- | --- | --- |
| 前端下发 Parse Master Key | 任意人可读取、修改、删库 | 前端改为 BFF 适配层，服务端密钥环境变量化 |
| Parse / Dashboard 暴露在公网 | 数据库管理面和 REST API 被直接攻击 | Parse 仅监听 `127.0.0.1:1337`；默认不随应用安装 Dashboard |
| 公共 ACL、客户端建表 | 越权访问、任意建表 | BFF 使用服务端 RBAC；新建类默认私有 CLP；客户端建类关闭 |
| 伪造 `companyId` / 前端按钮权限 | 跨租户读写 | 用户、公司、角色从签名会话解析；服务端覆盖租户条件 |
| 岗位页面或按钮权限仅由前端隐藏 | 直接调用接口绕过菜单、按钮限制 | 岗位管理将业务 Route 与逐页 `routePermissions` 写入受控 RBAC 记录；服务端按岗位、页面和操作二次校验，系统岗位及成员的岗位/组织字段只能通过专用接口维护 |
| 删除或绕过组织归属字段 | 跨区域越权、历史数据悬空 | 业务表可显式启用 `organization` Pointer；查询、创建、修改按成员范围与下级组织过滤，字段和被引用的组织均受服务端保护 |
| Token 放在 Web Storage | XSS 后可长期窃取会话 | HttpOnly + SameSite=Strict Cookie，变更请求需 CSRF Header |
| 首页登录统计泄露其他成员活动 | 越权观察、用户行为暴露 | 登录活动记录使用私有 CLP；`/api/dashboard/overview` 固定按 `req.auth.user` 与 `req.auth.company` 过滤，只返回当前账号的汇总 |
| 任意上传路径和文件名 | 路径穿越、任意文件写入 | 鉴权、白名单 MIME、大小上限、随机文件名、根目录校验 |
| 老旧依赖与 XLSX 导出 | 已知漏洞和供应链维护成本 | 更新运行时依赖；移除 Parse 浏览器 SDK、富文本/XLSX 依赖；CSV 导出防公式注入 |
| 把协同文档当作普通 Parse 数据类 | ACL、版本和文件边界不一致 | 文档元数据使用独立 `collab` Schema，服务层统一执行 Company、组织、页面权限和文档 ACL |
| 把企业内公开误作匿名链接 | 未登录外部访问文档 | `company_public` 只对同 Company 内已登录且符合组织范围的成员开放；匿名分享首期关闭 |
| 未配置编辑器却伪造实时协同 | 用户误以为内容已保存或已同步 | editor-config 返回明确待部署状态；当前不启用自研 WebSocket/CRDT，在线协同由 ONLYOFFICE 提供 |
| 回调或文件服务绕过浏览器会话 | 伪造保存、SSRF 或旧权限令牌继续使用 | Office 文件和回调使用独立短时 JWT，校验 document/company/accessVersion；回调下载地址限制在受信 Office Origin |

## 首次部署

1. 备份 PostgreSQL，并立即轮换旧的数据库口令、Parse App ID / Master Key、JWT 密钥和任何曾提交的 TLS 私钥。
2. 复制 `.env.example` 为 `.env`，填入随机高强度值。建议使用独立、最小权限的 PostgreSQL 应用账号。
3. 启动 API：`npm ci && npm start`。公网只反向代理到 `3000`；不要发布 `1337`。
4. 在 API 已启动的受控终端运行一次 `npm run seed:initial`。它不再创建固定默认密码，必须提供 `INITIAL_ADMIN_*`。
5. 部署前端产物，并将 `/api` 反向代理至 API 的 `3000` 端口。开发时 `vue.config.js` 已完成该代理。
6. 执行 `npm run migrate:collab` 创建或升级协同 PostgreSQL Schema；该脚本按迁移版本幂等运行，使用 `COLLAB_DATABASE_URI`，未设置时复用 `DATABASE_URI`。
7. 验证现有记录都带有 `company` 指针后，运行 `npm run security:harden` 将已有 Parse 类的 CLP 收紧为私有。此命令需在 Parse 内部端点可达时运行。

## 运行约束

- `npm run audit:prod` 必须保持无 high / critical；CI 会执行此检查。
- Dashboard 若确有运维需要，应作为独立、短时、私网工具运行，不得挂载到业务域名。
- 协同文件默认位于 `resources/collab`，必须位于静态资源根目录之外；生产环境应替换为受控、可备份的对象存储或共享存储。
- `COLLAB_DATABASE_URI` 可以与 Parse 使用同一 PostgreSQL 实例，但生产建议使用独立最小权限账号；迁移只执行 `admin_server/migrations/collab` 中的版本化 SQL。
- 每个协同文档可保存独立的 `storage_limit_bytes`（1 KB 至 1 TB）；服务端在导入、Office 保存和历史版本恢复前校验当前快照大小，未设置时仍执行 `COLLAB_MAX_FILE_BYTES` 的单文件保护。
- 文档活动记录写入追加式 `collab.document_audit_events`，包括 Office 自动保存、导入、恢复、版本、下载和权限/设置变更；历史查询按当前 Company 与文档 ACL 分页返回，不暴露物理对象键。
- `company_public` 不是匿名分享；匿名 token、下载链接和外部协作者首期未启用。
- 当前没有自研 WebSocket、CRDT/OT、Redis 广播或连接失效服务。`COLLAB_WS_MAX_CONNECTIONS`、`COLLAB_SNAPSHOT_INTERVAL` 是未来自研路线的保护性预留配置，不代表当前已提供这些能力。
- 配置 ONLYOFFICE 时，浏览器地址使用 `OFFICE_DOCUMENT_SERVER_URL`，BFF 内部访问使用 `OFFICE_INTERNAL_URL`；`OFFICE_JWT_SECRET` 只存在服务端。编辑器下发 `lang=zh`、`region=zh-CN` 和不可切换的 `coEditing.mode=fast`，由 Document Server 广播远程选区并在悬停时显示服务端可信的 `user.name`。Office 回调和文件读取均不依赖浏览器 Cookie/CSRF，而依赖独立令牌：文件读取令牌短时有效，回调令牌覆盖一次工作日编辑窗口，并始终绑定文档、Company 和 `access_version`。
- 富文本字段现在以纯文本编辑，避免将不可信 HTML 直接存储和回显。若业务必须恢复富文本，请先引入服务端白名单清洗和 CSP 评审。
- CSV 适用于 Excel 打开和数据交换；导出程序会转义公式前缀以防 CSV 注入。
- `LoginActivity` 是 BFF 内部统计类：在首次成功登录时按需创建，带有私有 CLP，不出现在低代码 Schema 管理页面，也不能通过通用数据 API 查询。它只保存 Company、用户指针、内部会话关联 ID 与创建时间；不保存 IP、密码或浏览器指纹。
- 此次未改写 Git 历史。已被提交过的 `ssl/*.key` / `ssl/*.pem` 必须吊销并在确认协作影响后用仓库历史清理流程移除。
