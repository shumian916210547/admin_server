# Admin Server 开发约定

本文件适用于 `admin_server`。这是 Shumian Vue Admin 的 Express BFF 与内部 Parse Server 运行时。

## 结构

```text
admin_server/
├─ config/                       # 环境变量解析、默认值和安全校验
├─ lib/                          # async handler、HTTP 错误、日志
├─ middleware/                   # 请求上下文、Origin/CSRF、认证
├─ routes/api/                   # 当前启用的 BFF API
├─ services/                     # 会话、数据、Schema 与 Parse Server 服务
├─ scripts/                      # 初始化、检查、权限加固
├─ docs/                         # 架构与安全说明
├─ app-factory.js                # 公共 Express 应用工厂
├─ main.js                       # 公共 BFF 与内部 Parse Server 启动入口
├─ README.md                     # API、配置、结构和快速开始
└─ package.json
```

历史 `controller/`、`routes/admin/`、`routes/cmn/` 和 `routes/miniapp/` 未由当前 `app-factory.js` 挂载；新增功能不得依赖这些路径。

## 规则

- 使用 CommonJS、2 空格缩进、双引号、分号；默认使用 `const`，仅在需重新赋值时用 `let`。
- **函数与参数注释为强制要求：** 每个路由处理器、中间件、服务函数、工具函数和脚本入口都必须说明用途、输入参数（名称、类型、可选性、格式）、返回值、授权前提、可能错误和数据副作用；复杂请求体、Schema 字段、权限标识及非直观常量也必须在定义处说明。
- 新公开 HTTP API 加在 `routes/api/index.js`，用 `async-handler` 包装，使用 `HttpError` 返回预期错误，并复用统一日志与错误中间件。
- 受保护请求必须经过 `authenticate`；所有改变状态的请求必须经过 `csrfGuard`。不得以客户端传入的 `companyId`、角色或权限作为可信依据。
- 认证、租户、角色、数据访问和 Schema 操作优先复用 `services/parse-data.service.js`；路由层只负责 HTTP 参数、授权流程和响应。
- Parse Master Key、数据库 URI、JWT 密钥和内部 Parse URL 只能存在于服务端 `.env`。Parse Server 保持绑定 `127.0.0.1:1337`，禁止向浏览器或公网暴露 `/parse`。
- 新环境变量必须通过 `config/env.js` 解析与校验，并同步 `.env.example`、README 和系统使用文档；不允许使用 `*` 作为 CORS 来源。
- 上传必须使用 MIME 白名单、大小限制、随机文件名和受控存储目录；永远不要信任客户端文件名或路径。
- Schema、字段删除、CLP 加固和权限收紧前先备份 PostgreSQL，在隔离环境验证恢复。系统字段和平台类不可让客户端修改或删除。
- 不提交 `.env`、密钥、私钥、数据库备份、生产日志或含个人数据的样例。新增功能时同步更新 README、`docs/architecture.md`（如架构变化）及工作区使用文档。

## 验证

```powershell
npm run check
npm run security:check
npm run audit:prod
```

涉及登录、权限、租户、文件或 Schema 时，还需进行跨租户、CSRF、文件类型和权限回归测试。
