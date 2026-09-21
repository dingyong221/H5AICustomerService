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

远程 HTTP MCP 必须在进入工具执行前完成 OAuth 发现和 Bearer 校验。当前 Nest 入口已在原始 MCP transport 前返回标准 HTTP `401` challenge；适配器内部的结构化认证错误仅作为纵深防御。MySQL OAuth仓储代码虽已存在，但生产数据库配置、verifier、账号会话和真实WorkBuddy客户端尚未接通，因此这一实现仍不能作为发布证据。

| 协议面                        | 目标契约                                                                                                                                                 | 当前状态                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 401/403 challenge             | 缺失/无效/过期 token 时返回 HTTP `401` 和 `resource_metadata`；scope 不足返回 `403`，并带 `error="insufficient_scope"`、最小 `scope` 和同一 metadata URL | 本地 middleware 与缺 token 测试已实现；生产 verifier、403 scope challenge/错误矩阵未实测                           |
| Protected Resource Metadata   | 主地址 `/.well-known/oauth-protected-resource/mcp`，`resource` 精确等于 `https://h5cs.1rying.com/mcp`，并列出授权服务器和 scopes                         | 标准路径与根路径兼容别名均已实现；正式域名尚未部署                                                                 |
| Authorization Server Metadata | `/.well-known/oauth-authorization-server` 公布 issuer、authorization/token/registration endpoints、grants、scopes、`S256` 和 token endpoint 认证方式     | 本地实现并通过 Schema 测试；正式 issuer 尚未部署                                                                   |
| 客户端注册                    | WorkBuddy 当前要求 DCR 公共客户端，`token_endpoint_auth_method=none`，不签发或要求 `client_secret`；MCP 2026 已优先 CIMD、保留 DCR 兼容                  | DCR服务、MySQL仓储/迁移与正负测试已实现；需显式`MYSQL_DATABASE_URL`且尚无生产库，CIMD/预注册和目标客户端协商未实测 |
| 授权与换票                    | Authorization Code + PKCE S256；校验 `state`、一次性 code、`resource`、client、issuer/`iss` 和逐字匹配的 redirect URI；Bearer 只从 header 读取           | 本地服务、一次性 code、PKCE/JWT 和 RFC 9207 `iss` 正负测试已实现；生产登录/同意会话与签名密钥未接入                |
| 回调                          | 优先 `workbuddy://workbuddy/mcp/connector%3A<source>/oauth/callback`；私有 scheme 被拒时回退一次到 `http://127.0.0.1:{dynamic-port}/oauth/callback`      | 精确 source 与 `127.0.0.1` 动态端口限制已有测试；目标 WorkBuddy 客户端未实测                                       |
| 刷新与撤销                    | 短期 access token；refresh token 轮换、重用检测和撤销；断开、成员关系变化或账号停用后失效                                                                | MySQL原子轮换/重放撤销仓储与测试已实现；正式签名、grant/binding撤销端点与传播未实现                                |

### 两套 OAuth 凭据不得混用

| 凭据                     | 签发方/客户端                                                             | 唯一用途                                                                           | 禁止                                                                                   |
| ------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Connector OAuth token    | 本平台签发；WorkBuddy 是无 `client_secret` 的公共客户端                   | Bearer 调用 `https://h5cs.1rying.com/mcp`，audience/resource 仅限该 MCP            | 不得发往 WorkBuddy Open API，不得作为 H5/后台会话，不得透传给下游                      |
| WorkBuddy Open API token | WorkBuddy 签发；本项目第三方应用是持有 `client_secret` 的服务端机密客户端 | 后端调用 `https://www.workbuddy.cn/openapi/v2/*`，并从服务端换票结果取得 `open_id` | 不得提交给 `/mcp`，不得交给 Skill、Connector、浏览器或模型，不得兑换成 Connector token |

两套凭据需要独立配置名、存储记录类型、轮换/撤销入口和审计字段。日志只能记录凭据类型、issuer、audience/resource、client ID、scope、到期和结果，禁止记录 access token、refresh token、authorization code 或 `client_secret`。

### WorkBuddy 第三方应用 OAuth 接入约束

这一流程只用于本项目后端调用 WorkBuddy Open API 和获取可信 `open_id`，不属于 Connector OAuth：

1. 浏览器访问 `GET https://www.workbuddy.cn/openapi/v2/authorize`；必须使用已审核应用、登记的唯一 HTTPS callback、最小 scopes，以及服务端生成的短期一次性 `state`。state 绑定浏览器会话、平台用户、目标商家、redirect URI 和 scopes，回调时原子消费。
2. 后端以 `application/x-www-form-urlencoded` POST `https://www.workbuddy.cn/openapi/v2/token`，携带一次性 code、字节级一致的 redirect URI、`client_id` 和只存在于 Secret Manager 的 `client_secret`。当前 WorkBuddy 第三方应用参数表没有声明 PKCE，未经官方确认和实机验证不得声称支持，也不得把 Connector 的私有 scheme/loopback 回调套到这里。
3. 响应必须校验 `token_type=Bearer`、正整数 `expires_in`、实际 scope 和非空 `open_id`。当前仅用于建立外部主体时，完成`open_id` HMAC派生后立即丢弃两种Token；只有phoneverification或其他获批Open API确需后续调用时，才在同一事务内加密保存。WorkBuddy 当前概览与中英文 Open API 示例的access-token时长不一致，调度只能采用每次响应的`expires_in`，不能硬编码1小时、24小时或7天。
4. refresh 使用同一 `/token`、`grant_type=refresh_token` 和服务端应用凭据。对同一授权记录单飞刷新；若返回新 refresh token，原子替换并在提交后销毁旧值。`invalid_grant` 是重新授权终态，403/`invalid_scope` 不靠刷新解决；网络/5xx 只能有界退避，不能并发盲重试。
5. 刷新返回的 `open_id` 必须与已绑定 `(issuer, client_id, open_id)` 一致，scope 不得静默扩大；缺失、变化或权限缩减到无法完成绑定用途时 fail closed。`open_id` 只能来自服务端 token 响应，不能接受浏览器、Skill、MCP 工具或用户自报值。
6. `POST /openapi/v2/user/phoneverification` 仅在获批 `user.contact.readable`、平台用户已登录并完成 OTP/再认证后由后端调用。它只返回 `matched`，不返回手机号；结果只是绑定补强信号，不是登录凭据、唯一标识或商家授权，不能自动合并账号。

本轮所查官方第三方应用/Open API 页面未公开第三方应用 token/grant revocation 端点。用户解绑时，本平台必须立即冻结绑定、停止刷新、销毁本地 WorkBuddy token、撤销本平台 Connector grant/会话并清理相关任务/缓存，但不能把这些动作描述成已经撤销 WorkBuddy 侧授权。WorkBuddy 侧授权管理入口和远端撤销 API 都需要官方确认；在此之前 UI 必须准确提示两边撤销的差异。

当前本地代码已有固定官方端点的 authorize URL 构造、服务端授权码换票响应校验、state 一次性消费接口、`open_id` HMAC 派生身份和相应单元测试；桥接结果不会返回原始 `open_id` 或 token。它尚未接入生产 callback 路由、真实应用配置、持久化 state/绑定仓储、加密 token 保管、refresh、phoneverification 或解绑流程，因此只算本地安全骨架，不是可用的 WorkBuddy 第三方应用集成。

### 配置清单（仅名称与约束）

| 配置                                                                              | 约束                                                                                                      |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 第三方应用 `client_id`、`client_secret` 引用、HTTPS callback、获批 scopes         | 开发/测试/生产应用隔离；secret 仅后端 Secret Manager 可读，不写真实值到仓库、数据库明文、前端或 Connector |
| WorkBuddy authorize/token/Open API base URL allowlist                             | 固定为官方 HTTPS host，用户、模型和数据库字段不能覆盖                                                     |
| state 密钥引用、TTL、一次性仓储、callback session 绑定                            | state/code 禁止日志；重放、错 session、错商家和错 redirect 全部拒绝                                       |
| token 加密密钥引用、凭据类型、issuer/client/open_id 查找键版本、scope、expires_at | 与 Connector OAuth 完全隔离；只有后端服务身份能读取或解密                                                 |
| refresh 提前量、单飞锁、超时、重试预算、`invalid_grant` 与字段漂移策略            | 按实际 `expires_in` 计算；未知结果不并发重放；新 refresh token 原子替换                                   |
| phoneverification 开关、号码规范化、限流、审计                                    | 未获 scope 或未完成平台 OTP/再认证时关闭；港澳号码必须带区号；不记录原手机号                              |
| 解绑流程、用户提示、支持入口                                                      | 本地幂等销毁和 Connector 撤销可配置；WorkBuddy 远端撤销保持“待官方确认”，禁止填写猜测 URL                 |

## 尚未完成且阻止发布的内容

- 缺少官方要求的 `icon.svg`/`icon.png`/`icon.jpg`，也未准备隐私、权限用途、支持与撤销说明等审核材料。
- 已实现OAuth MySQL仓储/迁移并在显式`MYSQL_DATABASE_URL`时装配，但尚无托管生产库；正式签名密钥/KMS、平台登录与授权同意会话、身份绑定解析器或撤销端点仍未实现。因此DCR之外的authorize/token和受保护调用继续fail closed，不会假成功。
- WorkBuddy 第三方应用尚未注册/审核；本地 authorize/换票/身份桥接骨架虽有单元测试，但生产 callback 路由与配置、持久化 state/绑定仓储、加密 token 保管、单飞刷新、phoneverification 和解绑流程均未接通；官方远端撤销入口也尚未确认。
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
pnpm --filter @h5cs/contracts build
pnpm --filter @h5cs/api exec vitest run test/workbuddy-mcp.test.ts test/oauth.test.ts test/workbuddy-identity-bridge.test.ts
```

先刷新 workspace contracts 构建产物，避免 API 测试加载旧 Schema。协议测试使用官方 TypeScript SDK 客户端完成初始化、`tools/list` 和 `tools/call`，并覆盖四工具发现、transport Bearer、严格参数、内部事件隔离以及鉴权/数据库未配置错误；OAuth/身份桥接测试覆盖 metadata、PKCE、RFC 9207 `iss`、固定 WorkBuddy 端点、一次性 state、响应字段和 HMAC 主体派生。它们只证明本地安全骨架，不证明真实换票、远程服务或 WorkBuddy 安装可用。

服务端与协议测试当前固定使用官方 `@modelcontextprotocol/sdk` 1.30.0；升级协议或迁移到该 SDK 后续拆分包前，必须重新执行本节协议测试和目标 WorkBuddy 客户端验证。

本批验收包含官方文档/RFC 交叉审查、非秘密 Connector 元数据/Skill 静态核对、四工具本地协议测试、Connector OAuth 正负测试，以及第三方应用 authorize/换票/state/HMAC 身份桥接的本地测试材料核对；没有执行真实第三方应用换票、远程 OAuth、生产部署或真实 WorkBuddy 客户端测试。后续实机测试至少必须保存以下脱敏证据：

1. 无 token、过期 token、伪造 token 和错 audience token 均在工具执行前得到正确 401 challenge，scope 不足得到 403。
2. 资源 metadata、授权服务器 metadata、动态注册返回和 401 中的 URL/issuer/resource/endpoint 一致。
3. 公共客户端没有 secret；只接受 PKCE S256，不接受 `plain`；state、resource、redirect URI 和一次性授权码负例均被拒绝。
4. WorkBuddy 私有 scheme 成功；授权服务器拒绝时只回退一次到绑定 `127.0.0.1` 的动态端口，非回环/通配地址被拒绝。
5. access token 到期后刷新并重试成功；旧 refresh token 重用、撤销、断开和成员关系变化后均失败。
6. WorkBuddy Open API token 请求 `/mcp` 被拒绝；Connector token 不会被发送到 WorkBuddy Open API；日志、错误、遥测和 URL 无任何凭据值。
7. 第三方应用 callback 的 state 重放、错浏览器会话、错商家、错/变形 redirect URI，以及授权码过期/重放全部失败；`client_secret` 从未到达浏览器或日志。
8. 换票响应缺少/伪造 token type、`expires_in`、scope 或 `open_id` 时不建立绑定；分别用不同 `expires_in` 验证调度不依赖硬编码时长。
9. 并发 refresh 只有一个出站请求；返回新 refresh token 时原子替换；超时结果、`invalid_grant`、401、403、429 和 5xx 分别进入正确终态或有界重试，不出现循环刷新。
10. refresh 的 `open_id` 变化/缺失、scope 扩大/缩减均 fail closed，不会改绑主体或静默扩大权限。
11. phoneverification 覆盖大陆、港澳与含糊号码，matched 正反例、错 scope、限流和超时；任何响应都不泄露原手机号或自动合并账号。
12. 重复解绑、解绑与刷新并发、退出商家和账号停用都能立即停止本地使用并幂等销毁凭据；未有 WorkBuddy 官方撤销证据时，界面不会声称远端授权已撤销。

## 官方依据

- [WorkBuddy 开放平台：技能](https://open.workbuddy.cn/docs/skill)
- [WorkBuddy 客户端：技能](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
- [WorkBuddy 开放平台：连接器](https://open.workbuddy.cn/docs/connector)
- [WorkBuddy 开放平台：第三方应用](https://open.workbuddy.cn/docs/third-party-app)
- [WorkBuddy 开放平台：Open API](https://open.workbuddy.cn/docs/openapi)
- [MCP Authorization Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [OAuth 2.1 draft-13](https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html)
- [RFC 6749 OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html)
- [RFC 9728 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [RFC 8414 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html)
- [RFC 7591 Dynamic Client Registration](https://www.rfc-editor.org/rfc/rfc7591.html)
- [RFC 9207 Authorization Server Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207.html)
- [RFC 8252 OAuth for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 6750 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)
- [RFC 9700 OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html)
- [RFC 7009 OAuth 2.0 Token Revocation](https://www.rfc-editor.org/rfc/rfc7009.html)
- [Model Context Protocol 官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
