# Shumian Admin Server · Secure Express BFF

[![API CI](https://github.com/shumian916210547/admin_server/actions/workflows/ci.yml/badge.svg)](https://github.com/shumian916210547/admin_server/actions/workflows/ci.yml)

Shumian Vue Admin 的后端服务。当前运行架构是 **Express BFF + 内网 Parse Server + PostgreSQL**：浏览器只访问 `/api`，服务端负责会话、CSRF、RBAC、Company 租户边界、Schema 操作、协同文档和受控文件上传。

> English: A secure Node.js Express BFF for a schema-driven, multi-tenant low-code admin platform with RBAC, organization scopes, Parse Server, and PostgreSQL.

**搜索关键词：** Express BFF、Node.js Admin API、低代码平台后端、Schema 驱动 CRUD、RBAC、Multi-tenant SaaS、组织树权限、租户隔离、Parse Server、PostgreSQL、CSRF、HttpOnly Cookie。

## 当前能力

- 安全登录、会话恢复与退出：HttpOnly、SameSite=Strict Cookie，写操作校验 CSRF。
- 在线成员会话治理：私有 `AdminSession` 记录设备摘要、心跳和滑动过期时间；管理员可强制撤销目标成员全部会话或按分钟冻结账号。
- 个人工作台统计：成功登录后以私有 `LoginActivity` 记录当前用户活动，BFF 仅返回本人登录趋势、活跃天数和会话起点汇总。
- Company 租户隔离：服务端从会话解析用户、公司和角色，不信任客户端传入的 `companyId`。
- RBAC：管理员与普通岗位动作权限由 `Role`、`Route`、`AllotPermission` 共同约束；岗位可以按页面分别配置按钮权限。
- 组织范围治理：系统管理员分开维护企业组织、成员和岗位；成员可关联多个组织、设置一个岗位，并配置多个组织数据范围，范围会自动覆盖下级节点并参与业务数据查询、创建和修改校验。
- 通用数据 API：查询、创建、更新、删除，并限制查询数量和字段访问。
- Schema API：仅管理员可创建、修改、删除业务数据类；平台字段与系统类受保护。
- 低代码组织建模：新建业务表可自动创建 `organization` Pointer 及 Schema 元数据；被成员或业务数据引用的组织不能删除。
- 基础配置自恢复：管理员可幂等补齐模块管理、数据表管理、组织与成员入口，并逐字段补齐历史 Schema 缺失的系统元数据而保留自定义配置。
- 文件上传：鉴权、MIME 白名单、大小限制、随机文件名和安全路径校验。
- 在线协同表格：独立 `collab` PostgreSQL Schema 保存文档、成员 ACL、版本和追加式修改记录；支持独立列表/编辑页所需的文档元数据、`xlsx`/`csv` 导入、受控下载/导出、每文档 KB/MB/GB 容量上限、软删除/恢复、文件所有权转移和 ONLYOFFICE 配置/回调。ONLYOFFICE 编辑器固定为简体中文 Fast 协同模式，其他成员的彩色选区支持悬停查看姓名。
- 协同访问边界：`members` 只允许 owner/active 成员（系统管理员按平台权限处理），`company_public` 只允许同 Company 内已登录且符合组织范围的成员查看；默认禁止下载，匿名分享未启用。
- 当前未提供自研 WebSocket/CRDT/OT；未配置 ONLYOFFICE 时文档中心和权限接口可用，但编辑器明确返回待部署状态。
- 内部 Parse Server：默认仅绑定到 `127.0.0.1:1337`，浏览器不能直接访问。
- 初始化、安全检查和 CLP 加固脚本。

## 快速开始

### 环境要求

- Node.js 20+
- PostgreSQL 14+

```powershell
Copy-Item .env.example .env
# 编辑 .env，替换所有 placeholder
npm ci
npm run migrate:collab
npm start
```

`npm run migrate:collab` 会在 `COLLAB_DATABASE_URI`（未设置时回退到 `DATABASE_URI`）中幂等创建协同 Schema 和表。协同文件默认写入 `resources/collab`，请确保运行账号有写权限，并将该目录置于静态资源之外。

首次运行时，在 `.env` 设置 `INITIAL_ADMIN_USERNAME` 和 `INITIAL_ADMIN_PASSWORD`，再于受控终端执行：

```powershell
npm run seed:initial
```

本地开发环境（`NODE_ENV=development`）允许使用便于测试的短密码，重复执行初始化会同步该配置密码；非本地环境仍要求至少 12 位密码，且不会重置已有账号密码。`.env` 仅供本机使用，禁止提交或部署到生产环境。

公共 BFF 默认监听 `http://localhost:3000`，健康检查为 `GET /healthz`。Parse Server 默认监听 `127.0.0.1:1337`，严禁直接发布该端口或把 Dashboard 暴露在业务域名下。

## 环境变量

所有环境变量示例见 [.env.example](.env.example)。生产环境至少需要：

- `DATABASE_URI`
- `PARSE_APP_ID`
- `PARSE_MASTER_KEY`
- `AUTH_JWT_SECRET`
- `PUBLIC_ORIGIN`
- `CORS_ORIGINS`

使用独立、最小权限的数据库账号。不要把 `.env`、TLS 私钥、生产日志或数据库备份提交到 Git。

协同配置：

| 变量 | 默认值/要求 | 说明 |
| --- | --- | --- |
| `COLLAB_DATABASE_URI` | 空，回退到 `DATABASE_URI` | 协同数据库连接；生产建议使用独立账号。 |
| `COLLAB_STORAGE_DIR` | `resources/collab` | 协同源文件和版本对象的服务端存储根目录。 |
| `COLLAB_MAX_FILE_BYTES` | `52428800` | 单个协同文件上限，单位为字节。 |
| `COLLAB_MAX_LIST_PAGE_SIZE` | `100` | 文档列表单页上限。 |
| `COLLAB_ALLOWED_ORIGINS` | 未设置时继承 `CORS_ORIGINS` 或 `PUBLIC_ORIGIN` | 协同来源白名单，必须是明确来源；当前自研 WebSocket 未启用。 |
| `COLLAB_WS_MAX_CONNECTIONS` | `1000` | 未来 WebSocket 方案的保护性上限。 |
| `COLLAB_SNAPSHOT_INTERVAL` | `250` | 未来自研快照方案的操作间隔。 |
| `OFFICE_DOCUMENT_SERVER_URL` | 空 | ONLYOFFICE 的浏览器访问地址。 |
| `OFFICE_INTERNAL_URL` | 空 | BFF 访问 ONLYOFFICE 的内部地址；未设置时回退浏览器地址。 |
| `OFFICE_JWT_SECRET` | Office 未启用时为空 | 仅后端使用的文件/回调 JWT 密钥；文件令牌短时有效，回调令牌覆盖一次工作日编辑窗口，配置任一 Office 地址后必填。 |

ONLYOFFICE 的浏览器地址必须能被前端访问，BFF 地址必须能访问 Office 服务，Office 服务还必须能访问 BFF 的 `/api/collab/office/files/:documentId` 和回调地址。任何数据库 URI、内部地址和 JWT 密钥都不能放入前端配置。

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 公共健康检查。 |
| `POST` | `/api/auth/login` | 登录并建立会话。 |
| `GET` | `/api/auth/session` | 恢复会话。 |
| `POST` | `/api/auth/logout` | 退出登录。 |
| `GET` | `/api/dashboard/overview` | 获取当前账号自身的登录与活跃统计，包含有登录记录的自然日。 |
| `GET` | `/api/online-members` | 系统管理员查看当前企业在线会话的成员、手机号、时间和设备摘要。 |
| `POST` | `/api/online-members/:userId/force-logout` | 系统管理员撤销目标成员全部管理端会话，需要 CSRF。 |
| `POST` | `/api/online-members/:userId/freeze` | 系统管理员按分钟冻结账号并撤销其现有会话，需要 CSRF。 |
| `GET/POST/PUT/DELETE` | `/api/organization/...` | 系统管理员维护组织树、成员账号、多个关联组织与多个组织数据范围；成员查询使用服务端分页、账号检索和直属/后代组织筛选。 |
| `GET/POST/PUT/DELETE` | `/api/positions...` | 系统管理员维护岗位可访问页面和逐页按钮权限。 |
| `POST` | `/api/system/ensure-configuration` | 为当前系统管理员所在企业幂等补齐模块、表格、组织、成员和岗位基础配置。 |
| `POST` | `/api/data/query` | 受授权的业务数据查询。 |
| `POST/PUT/DELETE` | `/api/data/:className[/id]` | 受授权的数据写操作。 |
| `GET/POST/PATCH/DELETE` | `/api/schema...` | 管理员 Schema 操作。 |
| `POST` | `/api/files` | 受控文件上传。 |
| `GET/POST` | `/api/collab/documents` | 查询或创建协同文档。 |
| `GET/PATCH/DELETE` | `/api/collab/documents/:id` | 查看、修改或软删除文档。 |
| `POST` | `/api/collab/documents/:id/restore` | 恢复软删除文档。 |
| `POST` | `/api/collab/documents/:id/transfer-ownership` | 将文件所有权转移给当前 Company/组织范围内的有效成员，需要 CSRF 和乐观锁版本。 |
| `GET` | `/api/collab/documents/:id/editor-config` | 获取文档权限和 ONLYOFFICE 编辑器配置。 |
| `POST/GET` | `/api/collab/documents/:id/import`、`/export` | 导入或受控导出 `xlsx`/`csv`。 |
| `PATCH/GET/PUT/DELETE` | `/api/collab/documents/:id/access`、`/members...` | 管理访问模式和成员 ACL。 |
| `GET/POST` | `/api/collab/documents/:id/versions` | 查询或创建命名版本。 |
| `GET` | `/api/collab/documents/:id/activity` | 分页查询文档修改记录和管理活动。 |
| `POST` | `/api/collab/documents/:id/versions/:versionId/restore` | 从历史版本生成新的当前版本。 |
| `GET/POST` | `/api/collab/office/files/:documentId`、`/callback/:documentId` | ONLYOFFICE 短时签名文件读取和保存回调，不使用浏览器会话。 |

完整的操作说明和 API 约束见 [系统使用文档](../docs/SYSTEM_USAGE.md)。

## 后端结构

```text
admin_server/
├─ config/                       # 环境变量解析与安全默认值
├─ middleware/                   # 请求上下文、Origin/CSRF、认证
├─ routes/api/                   # 当前启用的 BFF 路由
├─ services/                     # 会话、Parse 数据、Schema、协同文档与运行时服务
├─ migrations/collab/             # 协同 PostgreSQL Schema 迁移
├─ lib/                          # async handler、错误、日志
├─ scripts/                      # 初始化、检查、CLP 加固
├─ docs/                         # 架构与安全说明
├─ app-factory.js                # 公共 Express BFF 工厂
└─ main.js                       # 公共服务与内部 Parse Server 启动入口
```

仓库中保留的 `controller/`、`routes/admin/`、`routes/cmn/`、`routes/miniapp/` 等为历史代码，当前 `app-factory.js` 未挂载它们。新增功能必须实现到 `routes/api/` 并使用 `authenticate`、`csrfGuard`、`async-handler` 和 `services/`。

## 质量与安全检查

```powershell
npm run check
npm run security:check
npm run audit:prod
npm run test:collab
npm run test:collab-browser

# 确认备份和租户字段完整后，才可执行
npm run security:harden
```

详细安全架构见 [docs/architecture.md](docs/architecture.md)，开发规则见 [AGENTS.md](AGENTS.md)。发布开源仓库前，请由权利人确认并补充合适的 `LICENSE` 文件、Topics、Release 说明和安全披露渠道。

协同表格的三轮完整回归需要先启动 BFF、完成协同数据库迁移，并在当前 `.env` 中提供初始化管理员账号；测试会创建随机临时成员和文档，结束时执行清理：

```powershell
npm run test:collab
```

真实 Chromium 浏览器三轮回归还需要启动前端和 ONLYOFFICE，并把 `BROWSER_TEST_BASE_URL` 指向前端入口；Playwright 已作为本项目开发依赖安装，测试结束时同样会清理随机资源：

```powershell
$env:BROWSER_TEST_BASE_URL="http://localhost:4200"
npm run test:collab-browser
```

接口/白盒测试报告、真实浏览器三轮测试报告、修复报告、优化记录和 Bug 记录见工作区 `docs/ONLINE_COLLABORATIVE_SPREADSHEET_TEST_REPORT.md`、`docs/ONLINE_COLLABORATIVE_SPREADSHEET_BROWSER_TEST_REPORT.md`、`docs/ONLINE_COLLABORATIVE_SPREADSHEET_BROWSER_FIX_REPORT.md`、`docs/ONLINE_COLLABORATIVE_SPREADSHEET_OPTIMIZATION_LOG.md` 和 `docs/ONLINE_COLLABORATIVE_SPREADSHEET_BUG_LOG.md`。

## GitHub 项目主页建议

为提升 GitHub 搜索命中和项目定位清晰度，建议在仓库 **About** 中使用：

> Secure Node.js Express BFF for a schema-driven, multi-tenant low-code admin platform with RBAC, organization scopes, Parse Server, and PostgreSQL.

建议设置以下 Topics（按实际能力维护）：

`nodejs`、`express`、`express-bff`、`bff`、`low-code`、`schema-driven`、`rbac`、`multi-tenant`、`tenant-isolation`、`organization-tree`、`parse-server`、`postgresql`、`csrf`、`http-only-cookie`、`admin-api`、`enterprise-admin`。
