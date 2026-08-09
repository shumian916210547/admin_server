# Shumian Admin Server · Secure Express BFF

[![API CI](https://github.com/shumian916210547/admin_server/actions/workflows/ci.yml/badge.svg)](https://github.com/shumian916210547/admin_server/actions/workflows/ci.yml)

Shumian Vue Admin 的后端服务。当前运行架构是 **Express BFF + 内网 Parse Server + PostgreSQL**：浏览器只访问 `/api`，服务端负责会话、CSRF、RBAC、Company 租户边界、Schema 操作和受控文件上传。

> English: A secure Node.js Express BFF for a schema-driven, multi-tenant low-code admin platform with RBAC, organization scopes, Parse Server, and PostgreSQL.

**搜索关键词：** Express BFF、Node.js Admin API、低代码平台后端、Schema 驱动 CRUD、RBAC、Multi-tenant SaaS、组织树权限、租户隔离、Parse Server、PostgreSQL、CSRF、HttpOnly Cookie。

## 当前能力

- 安全登录、会话恢复与退出：HttpOnly、SameSite=Strict Cookie，写操作校验 CSRF。
- 个人工作台统计：成功登录后以私有 `LoginActivity` 记录当前用户活动，BFF 仅返回本人登录趋势、活跃天数和会话起点汇总。
- Company 租户隔离：服务端从会话解析用户、公司和角色，不信任客户端传入的 `companyId`。
- RBAC：管理员与普通岗位动作权限由 `Role`、`Route`、`AllotPermission` 共同约束；岗位可以按页面分别配置按钮权限。
- 组织范围治理：系统管理员分开维护企业组织、成员和岗位；成员可关联多个组织、设置一个岗位，并配置多个组织数据范围，范围会自动覆盖下级节点并参与业务数据查询、创建和修改校验。
- 通用数据 API：查询、创建、更新、删除，并限制查询数量和字段访问。
- Schema API：仅管理员可创建、修改、删除业务数据类；平台字段与系统类受保护。
- 低代码组织建模：新建业务表可自动创建 `organization` Pointer 及 Schema 元数据；被成员或业务数据引用的组织不能删除。
- 基础配置自恢复：管理员可幂等补齐模块管理、数据表管理、组织与成员入口，并逐字段补齐历史 Schema 缺失的系统元数据而保留自定义配置。
- 文件上传：鉴权、MIME 白名单、大小限制、随机文件名和安全路径校验。
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
npm start
```

首次运行时，在 `.env` 设置 `INITIAL_ADMIN_USERNAME` 和强密码 `INITIAL_ADMIN_PASSWORD`，再于受控终端执行：

```powershell
npm run seed:initial
```

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

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 公共健康检查。 |
| `POST` | `/api/auth/login` | 登录并建立会话。 |
| `GET` | `/api/auth/session` | 恢复会话。 |
| `POST` | `/api/auth/logout` | 退出登录。 |
| `GET` | `/api/dashboard/overview` | 获取当前账号自身的登录与活跃统计。 |
| `GET/POST/PUT/DELETE` | `/api/organization/...` | 系统管理员维护组织树、成员账号、多个关联组织与多个组织数据范围；成员查询使用服务端分页与账号检索。 |
| `GET/POST/PUT/DELETE` | `/api/positions...` | 系统管理员维护岗位可访问页面和逐页按钮权限。 |
| `POST` | `/api/system/ensure-configuration` | 为当前系统管理员所在企业幂等补齐模块、表格、组织、成员和岗位基础配置。 |
| `POST` | `/api/data/query` | 受授权的业务数据查询。 |
| `POST/PUT/DELETE` | `/api/data/:className[/id]` | 受授权的数据写操作。 |
| `GET/POST/PATCH/DELETE` | `/api/schema...` | 管理员 Schema 操作。 |
| `POST` | `/api/files` | 受控文件上传。 |

完整的操作说明和 API 约束见 [系统使用文档](../docs/SYSTEM_USAGE.md)。

## 后端结构

```text
admin_server/
├─ config/                       # 环境变量解析与安全默认值
├─ middleware/                   # 请求上下文、Origin/CSRF、认证
├─ routes/api/                   # 当前启用的 BFF 路由
├─ services/                     # 会话、Parse 数据、Schema、运行时服务
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

# 确认备份和租户字段完整后，才可执行
npm run security:harden
```

详细安全架构见 [docs/architecture.md](docs/architecture.md)，开发规则见 [AGENTS.md](AGENTS.md)。发布开源仓库前，请由权利人确认并补充合适的 `LICENSE` 文件、Topics、Release 说明和安全披露渠道。

## GitHub 项目主页建议

为提升 GitHub 搜索命中和项目定位清晰度，建议在仓库 **About** 中使用：

> Secure Node.js Express BFF for a schema-driven, multi-tenant low-code admin platform with RBAC, organization scopes, Parse Server, and PostgreSQL.

建议设置以下 Topics（按实际能力维护）：

`nodejs`、`express`、`express-bff`、`bff`、`low-code`、`schema-driven`、`rbac`、`multi-tenant`、`tenant-isolation`、`organization-tree`、`parse-server`、`postgresql`、`csrf`、`http-only-cookie`、`admin-api`、`enterprise-admin`。
