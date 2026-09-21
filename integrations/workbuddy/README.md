# WorkBuddy Connector 本地联调稿

> 状态：远程 Streamable HTTP MCP 与四个最小工具已可本地协议测试；当前不是可安装、可上传或可发布的成品。

本目录保存 H5 AI 客服的 WorkBuddy Connector/Skill 联调稿，面向两个自然语言入口：

1. **生成 AI 客服**：分步收集真实业务资料，预览并明确确认后，只创建可编辑草稿。
2. **打开已有客服后台**：在服务端已验证用户、商家和权限后，返回对应管理链接。

## 当前目录

```text
integrations/workbuddy/
├── connector-meta.json
├── mcp.json
├── README.md
└── skills/
    └── h5-ai-customer-service/
        ├── SKILL.md
        └── references/
            ├── workflows.md
            ├── fields-and-help.md
            ├── safety-and-confirmation.md
            └── errors-and-recovery.md
```

`connector-meta.json` 与 `mcp.json` 只含正式域名目标和非秘密配置；远程地址为 `https://h5cs.1rying.com/mcp`，单次连接超时为 25 秒。`SKILL.md` 的 `allowed-tools` 与服务端、本说明和协议测试统一为以下四项：

| 工具                               | 用途               | 鉴权                         |
| ---------------------------------- | ------------------ | ---------------------------- |
| `h5cs_help`                        | 查询支持能力       | 无需 Bearer                  |
| `h5cs_onboarding_create_or_resume` | 创建或恢复入驻会话 | Bearer 仅来自 HTTP transport |
| `h5cs_management_open`             | 打开管理入口       | Bearer 仅来自 HTTP transport |
| `h5cs_onboarding_advance`          | 提交用户侧入驻事件 | Bearer 仅来自 HTTP transport |

工具成功结果的 `structuredContent` 为 `{ ok: true, result, trace_id, request_id }`；业务失败为 `{ ok: false, code, message, retryable, trace_id, request_id }` 并设置 `isError=true`。错误码复用共享 HTTP `ErrorCode`。额外字段会被严格 Schema 拒绝，输入中没有 `open_id`、`merchant_id`、密码、OTP、Token 或 `authorization`。内部生成成功/失败事件不对外暴露。

## OAuth 协议审查结论

远程 HTTP MCP 必须在进入工具执行前完成 OAuth 发现和 Bearer 校验。当前 Nest 入口已在原始 MCP transport 前返回标准 HTTP `401` challenge；适配器内部的结构化认证错误仅作为纵深防御。生产 verifier、持久化和真实 WorkBuddy 客户端尚未接通，因此这一实现仍不能作为发布证据。

| 协议面                        | 目标契约                                                                                                                                                                        | 当前状态                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 401 challenge                 | 缺失/无效/过期 token 时返回 HTTP `401` 和 `WWW-Authenticate: Bearer resource_metadata="https://h5cs.1rying.com/.well-known/oauth-protected-resource/mcp"`；scope 不足返回 `403` | 本地 middleware 与缺 token 测试已实现；生产 verifier/错误矩阵未实测               |
| Protected Resource Metadata   | 主地址 `/.well-known/oauth-protected-resource/mcp`，`resource` 精确等于 `https://h5cs.1rying.com/mcp`，并列出授权服务器和 scopes                                                | 标准路径与根路径兼容别名均已实现；正式域名尚未部署                                |
| Authorization Server Metadata | `/.well-known/oauth-authorization-server` 公布 issuer、authorization/token/registration endpoints、grants、scopes、`S256` 和 token endpoint 认证方式                            | 本地实现并通过 Schema 测试；正式 issuer 尚未部署                                  |
| 动态注册                      | WorkBuddy 作为公共客户端，`token_endpoint_auth_method=none`，不签发或要求 `client_secret`；精确登记并回显回调地址                                                               | 服务与正负测试已实现；生产 MySQL 仓储未接入，真实运行时返回 503                   |
| 授权与换票                    | Authorization Code + PKCE S256；校验 `state`、一次性 code、`resource`、client 和逐字匹配的 redirect URI；Bearer 只从 header 读取                                                | 本地服务、一次性 code、PKCE/JWT 正负测试已实现；生产登录/同意会话与签名密钥未接入 |
| 回调                          | 优先 `workbuddy://workbuddy/mcp/connector%3A<source>/oauth/callback`；私有 scheme 被拒时回退一次到 `http://127.0.0.1:{dynamic-port}/oauth/callback`                             | 精确 source 与 `127.0.0.1` 动态端口限制已有测试；目标 WorkBuddy 客户端未实测      |
| 刷新与撤销                    | 短期 access token；refresh token 轮换、重用检测和撤销；断开、成员关系变化或账号停用后失效                                                                                       | 原子轮换/重放撤销仓储契约和测试已实现；生产仓储、撤销端点与传播未实现             |

### 两套 OAuth 凭据不得混用

| 凭据                     | 签发方/客户端                                                             | 唯一用途                                                                           | 禁止                                                                                   |
| ------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Connector OAuth token    | 本平台签发；WorkBuddy 是无 `client_secret` 的公共客户端                   | Bearer 调用 `https://h5cs.1rying.com/mcp`，audience/resource 仅限该 MCP            | 不得发往 WorkBuddy Open API，不得作为 H5/后台会话，不得透传给下游                      |
| WorkBuddy Open API token | WorkBuddy 签发；本项目第三方应用是持有 `client_secret` 的服务端机密客户端 | 后端调用 `https://www.workbuddy.cn/openapi/v2/*`，并从服务端换票结果取得 `open_id` | 不得提交给 `/mcp`，不得交给 Skill、Connector、浏览器或模型，不得兑换成 Connector token |

两套凭据需要独立配置名、存储记录类型、轮换/撤销入口和审计字段。日志只能记录凭据类型、issuer、audience/resource、client ID、scope、到期和结果，禁止记录 access token、refresh token、authorization code 或 `client_secret`。

## 尚未完成且阻止发布的内容

- 缺少官方要求的 `icon.svg`/`icon.png`/`icon.jpg`，也未准备隐私、权限用途、支持与撤销说明等审核材料。
- 没有实现生产 MySQL OAuth 仓储、正式签名密钥/KMS、平台登录与授权同意会话、身份绑定解析器或撤销端点；运行时仍使用不可用适配器，因此 metadata 与 401 之外的授权写操作会返回 503，不会假成功。
- 没有可用于生产的账号绑定、托管私网 MySQL、客服生成服务和目标 WorkBuddy 客户端实机证据。
- `mcp.json` 中的正式 HTTPS 地址只是部署目标；本轮没有部署该路由，也没有提交审核。
- 未写入 Client ID、Token、密钥或任何真实凭据；未来凭据仍只能由安全连接流程提供。

在图标、OAuth、账号绑定、数据库、生成闭环、远程部署和真实 WorkBuddy 客户端验证完成前，**禁止将本目录打包上传、提交审核或对外发布**。

## 当前目录与最终包差距

当前目录已经具有元信息、单 Server MCP 配置和 Skill；最终包仍至少需要图标：

```text
h5-ai-customer-service/
├── connector-meta.json
├── mcp.json
├── icon.svg
└── skills/
    └── h5-ai-customer-service/
        ├── SKILL.md
        └── references/
            ├── workflows.md
            ├── fields-and-help.md
            ├── safety-and-confirmation.md
            └── errors-and-recovery.md
```

发布前至少要完成：

1. 本平台 OAuth 2.1 + PKCE、动态注册、撤销和重新连接流程。
2. 生产 HTTPS MCP 路由、鉴权、数据库和生成服务的部署及回归。
3. 第三方应用 OAuth 返回的 `open_id` 如何在服务端绑定；普通 Skill/Connector 不得被假设会自动取得该标识。
4. 绑定、帮助和后台链接在目标 WorkBuddy 版本中的点击、复制和跨端行为。
5. Skill 自动/手动触发、启用/关闭、误触发和高风险确认的实机结果。
6. 隐私说明、权限用途、支持与撤销入口、版本兼容范围和审核材料。

## 本地验证

MCP 端点由 `apps/api/src/mcp/` 的 Nest middleware 提供。当前本地联调可运行：

```text
pnpm --filter @h5cs/api exec vitest run test/workbuddy-mcp.test.ts
```

协议测试使用官方 TypeScript SDK 客户端完成初始化、`tools/list` 和 `tools/call`，并覆盖四工具发现、transport Bearer、严格参数、内部事件隔离以及鉴权/数据库未配置错误。它只证明本地适配器协议行为，不证明远程服务或 WorkBuddy 安装可用。

服务端与协议测试当前固定使用官方 `@modelcontextprotocol/sdk` 1.30.0；升级协议或迁移到该 SDK 后续拆分包前，必须重新执行本节协议测试和目标 WorkBuddy 客户端验证。

本批验收包含官方文档/RFC 交叉审查、非秘密 Connector 元数据/Skill 静态核对、四工具本地协议测试，以及使用测试仓储/密钥/账号会话完成的 OAuth 正负测试；没有执行远程 OAuth、生产部署或真实 WorkBuddy 客户端测试。后续实机测试至少必须保存以下脱敏证据：

1. 无 token、过期 token、伪造 token 和错 audience token 均在工具执行前得到正确 401 challenge，scope 不足得到 403。
2. 资源 metadata、授权服务器 metadata、动态注册返回和 401 中的 URL/issuer/resource/endpoint 一致。
3. 公共客户端没有 secret；只接受 PKCE S256，不接受 `plain`；state、resource、redirect URI 和一次性授权码负例均被拒绝。
4. WorkBuddy 私有 scheme 成功；授权服务器拒绝时只回退一次到绑定 `127.0.0.1` 的动态端口，非回环/通配地址被拒绝。
5. access token 到期后刷新并重试成功；旧 refresh token 重用、撤销、断开和成员关系变化后均失败。
6. WorkBuddy Open API token 请求 `/mcp` 被拒绝；Connector token 不会被发送到 WorkBuddy Open API；日志、错误、遥测和 URL 无任何凭据值。

## 官方依据

- [WorkBuddy 开放平台：技能](https://open.workbuddy.cn/docs/skill)
- [WorkBuddy 客户端：技能](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
- [WorkBuddy 开放平台：连接器](https://open.workbuddy.cn/docs/connector)
- [WorkBuddy 开放平台：第三方应用](https://open.workbuddy.cn/docs/third-party-app)
- [WorkBuddy 开放平台：Open API](https://open.workbuddy.cn/docs/openapi)
- [MCP Authorization Specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [OAuth 2.1 draft-13](https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html)
- [RFC 9728 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [RFC 8414 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html)
- [RFC 7591 Dynamic Client Registration](https://www.rfc-editor.org/rfc/rfc7591.html)
- [RFC 8252 OAuth for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 6750 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)
- [Model Context Protocol 官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
