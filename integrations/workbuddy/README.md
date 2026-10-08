# WorkBuddy 技能与 Connector 接入

> 两条路线分开：`standalone-skills/` 是四个无本项目后端依赖的独立 Skill，可构建本地导入候选包；本目录根部的 MCP Connector 仍为联调稿，不是已上线或已审核的直连服务。禁止把整个目录当作成品包上传。

## 第一阶段独立技能

| 独立目录                               | 用途                                  | 与后端的关系                                |
| -------------------------------------- | ------------------------------------- | ------------------------------------------- |
| standalone-skills/h5cs-material-writer | 商家客服资料撰写、改写与备选          | 仅准备文字，不调用项目服务器                |
| standalone-skills/h5cs-faq-builder     | 从已有资料整理 FAQ、缺失项与冲突      | 仅整理资料，不上传或发布知识                |
| standalone-skills/h5cs-release-check   | 草稿与回答审查、试聊问题和核对清单    | 无真实回答时明确“未实测”，不自动发布        |
| standalone-skills/h5cs-web-guide       | 生成资料或打开已有后台的 Web 协同引导 | 创建、保存与发布仍由本人在独立商家 Web 完成 |

每个包自带 `SKILL.md` 和所需引用，不要求同时安装其他三个包。Skill 使用宿主当前模型，不需要本项目千问密钥，但不承诺用户文字完全离线或不由宿主处理。

构建前执行 `node scripts/skills/validate-workbuddy-skills.mjs`；单独打包执行 `powershell -NoProfile -File scripts/skills/build-workbuddy-skill-packs.ps1`，默认输出到 `artifacts/workbuddy-skills/`。已存在的包和清单不会被覆盖。构建过程校验引用、字段约束、秘密样式、ZIP 条目和逐文件摘要；不等于已通过真实 WorkBuddy 客户端导入或市场审核。

WorkBuddy 官方客户端支持在“技能 → 添加技能 → 上传技能”中导入本地包。逐个选择一个独立 ZIP，不选择本仓库根目录。首次验证建议从资料撰写助手开始。实机观察触发、文字输出、取消、字段修改、秘密误粘贴、未知价格和文档指令攻击；没有实机证据前不标记为可公开上架。

完整能力拆分、验收和下一阶段见 [Skill 能力沉淀与接入设计](../../docs/design/20-skill-capability-extraction.md)。以下章节仅描述根目录 MCP Connector，不适用于这些独立包。

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

| 协议面                        | 目标契约                                                                                                                                                 | 当前状态                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 401/403 challenge             | 缺失/无效/过期 token 时返回 HTTP `401` 和 `resource_metadata`；scope 不足返回 `403`，并带 `error="insufficient_scope"`、最小 `scope` 和同一 metadata URL | 本地 middleware 与缺 token 测试已实现；生产 verifier、403 scope challenge/错误矩阵未实测                 |
| Protected Resource Metadata   | 主地址 `/.well-known/oauth-protected-resource/mcp`，`resource` 精确等于 `https://h5cs.1rying.com/mcp`，并列出授权服务器和 scopes                         | 标准路径与根路径兼容别名均已实现；正式域名尚未部署                                                       |
| Authorization Server Metadata | `/.well-known/oauth-authorization-server` 公布 issuer、authorization/token/registration endpoints、grants、scopes、`S256` 和 token endpoint 认证方式     | 本地实现并通过 Schema 测试；正式 issuer 尚未部署                                                         |
| 客户端注册                    | WorkBuddy 当前要求 DCR 公共客户端，`token_endpoint_auth_method=none`，不签发或要求 `client_secret`；MCP 2026 已优先 CIMD、保留 DCR 兼容                  | DCR 服务、MySQL 仓储和本地测试已实现；Web MySQL 已可用，Connector 持久化授权与目标客户端协商仍需实机验收 |
| 授权与换票                    | Authorization Code + PKCE S256；校验 `state`、一次性 code、`resource`、client、issuer/`iss` 和逐字匹配的 redirect URI；Bearer 只从 header 读取           | 本地服务、一次性 code、PKCE/JWT 和 RFC 9207 `iss` 正负测试已实现；生产登录/同意会话与签名密钥未接入      |
| 回调                          | 优先 `workbuddy://workbuddy/mcp/connector%3A<source>/oauth/callback`；私有 scheme 被拒时回退一次到 `http://127.0.0.1:{dynamic-port}/oauth/callback`      | 精确 source 与 `127.0.0.1` 动态端口限制已有测试；目标 WorkBuddy 客户端未实测                             |
| 刷新与撤销                    | 短期 access token；refresh token 轮换、重用检测和撤销；断开、成员关系变化或账号停用后失效                                                                | MySQL原子轮换/重放撤销仓储与测试已实现；正式签名、grant/binding撤销端点与传播未实现                      |

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

当前本地代码已有固定官方端点的 authorize URL 构造、服务端授权码换票响应校验、state 一次性消费接口、`open_id` HMAC 派生身份和相应单元测试；桥接结果不会返回原始 `open_id` 或 token。工作区还出现了 callback/controller、平台会话与 consent 服务、可信服务端 UI 状态、授权事务/consent/反向唯一约束迁移及 MySQL 仓储草稿，但默认运行时仍显式不可用，平台登录与授权适配器未接通。它尚未接入真实应用配置、可用的持久化授权闭环、加密 token 保管、refresh、phoneverification 或解绑流程，因此只算本地安全骨架，不是可用的 WorkBuddy 第三方应用集成。

### 浏览器 session、唯一绑定与 consent 审查

当前草案会生成 256-bit 随机 state，并把其摘要、平台用户、登录 session 摘要及配置 ID/版本写入 MySQL 仓储；callback controller 读取 cookie 并重新解析平台会话，bridge 也会在 WorkBuddy 换票前按 state + session 原子消费并复核配置 ID/版本。这是正确的本地防线，但默认 runtime 尚未装配真实平台 session/事务/仓储，仍不能证明登录 CSRF/账号错绑在可运行系统中已经关闭。生产流程还须把精确 redirect URI、scopes 和目标商家贯穿到授权事务；错误 callback 也必须校验并消费 state。成功后轮换 session ID，页面不缓存、不发送 referrer，并立即清理 URL 中的 code/state。

| 控制           | 当前代码                                                                                                                                                                                            | 上线前要求                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| callback/UI    | 有严格成功回调 controller、cookie 传入、state + session 摘要原子消费仓储和可信服务端 UI 草案；三个写接口还要求 Origin、显式 CSRF header 和完整 session 校验；provider error 回调仍未进入 state 消费 | 装配真实平台 session/CSRF key，完成 cookie 属性/轮换、换号登录/转发链接/错误 callback 负例和真实跨站回调测试         |
| 外部主体唯一性 | 已有 HMAC 查找键和正向唯一约束；工作区新增反向唯一、状态/解绑字段、迁移及 MySQL bind 仓储，涵盖幂等和正反向冲突                                                                                     | runtime 尚未装配；未见主体不得暗中创建为“已绑定账号”；还需完成解绑/转绑策略和审计                                    |
| 商家解析/同意  | 有候选引用、0/1/多商家状态、逐次 consent 服务、迁移和 MySQL grant 仓储草稿；操作绑定 64 位事务引用与完整登录 session，单商家会预选但仍返回 `consent_required`，不会直接授权                         | runtime/adapters 未接通；服务接口还须把外部身份、client/resource/scopes 与 membership 版本贯穿到最终 grant           |
| Connector 授权 | authorization server 接口要求 resource-owner adapter 返回已同意的 binding ID                                                                                                                        | 生产 adapter 当前不可用；binding ID 必须解析到平台用户、外部身份、选定商家、client/resource/scopes，并在每次调用复核 |
| 撤销           | Connector refresh-token family 已有原子轮换与重放撤销仓储；身份/consent 状态字段仍是草案                                                                                                            | 尚无断开/撤销端点、binding/member 状态传播和 access-token denylist/在线 resolver；旧短期 JWT 不能只等自然过期        |

商家 consent 固定为：

| Active memberships | 行为                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------- |
| 0                  | 不签发 Connector grant/token；如需创建商家，转入独立入驻流程，完成后重新授权                |
| 1                  | 可预选，但仍展示商家、Connector/client、scopes、有效期与撤销方式并要求明确同意              |
| 多个               | 只能从服务端实时列表明确选一个；提交一次性选择引用，禁止自由输入 `merchant_id` 或由模型代选 |

consent 必须绑定用户、外部身份、商家、client、resource、scopes、membership 版本和同意时间；签发授权码、换票和每次 MCP 调用都复核。成员退出、商家停用、外部身份解绑或 consent 撤销时，refresh family 和旧 access token 都必须立即失效。

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

- 已补齐官方要求的市场图标 `icon.svg`；隐私、权限用途、支持与撤销说明等审核材料仍未准备。
- Web 已使用经项目负责人批准的单机 MySQL 并完成客服小闭环，不再把“没有托管生产库”列为 Skill 本身的阻碍。Connector 的正式签名配置、可运行的平台登录与授权同意、主体解析、撤销传播仍需完成；不可用时保持拒绝调用。
- WorkBuddy 第三方应用尚未注册/审核；本地 authorize/换票/身份桥接和 callback/consent/UI/迁移/MySQL 仓储草案虽已出现，state + browser-session 摘要及配置版本也已在本地 consume 路径核对，但默认 runtime 与平台登录/授权适配器仍不可用。完整 redirect/scope/merchant 事务快照、外部身份一对一上线、针对具体 client/resource/scopes/membership 的显式商家 consent、加密 token 保管、单飞刷新、phoneverification 和解绑流程均未形成可运行闭环；官方远端撤销入口也尚未确认。
- Web 账号、商家独立后台和客服生成发布已可用于受控测试，但这不证明 WorkBuddy 连接器的账号授权和目标客户端实机流程已经完成。
- `mcp.json` 中的正式 HTTPS 地址只是部署目标；本轮没有部署该路由，也没有提交审核。
- 未写入 Client ID、Token、密钥或任何真实凭据；未来凭据仍只能由安全连接流程提供。

根目录 MCP Connector 在 OAuth、账号授权、生成调用、远程接入、审核材料和真实 WorkBuddy 客户端验证完成前，**不得当作成品打包上传、提交审核或对外发布**。独立 Skill 只按前述范围构建本地测试候选包，不携带此目录的 `mcp.json` 或 Connector 配置。

## 当前目录结构与最终包差距

当前目录已经具有元信息、单 Server MCP 配置、图标和 Skill；以下结构齐备并不代表可以提交审核：

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
pnpm --filter @h5cs/database exec vitest run test/identity-authorization-repository.test.ts test/onboarding-repository.test.ts test/oauth-repository.test.ts
```

先刷新 workspace contracts 构建产物，避免 API 测试加载旧 Schema。协议测试使用官方 TypeScript SDK 客户端完成初始化、`tools/list` 和 `tools/call`，并覆盖四工具发现、transport Bearer、严格参数、内部事件隔离以及鉴权/数据库未配置错误；OAuth/身份桥接测试覆盖 metadata、PKCE、RFC 9207 `iss`、固定 WorkBuddy 端点、state + session + 配置版本一次性消费、响应字段和 HMAC 主体派生；数据库测试覆盖身份正反向冲突、bridge state、consent grant、OAuth 原子轮换和 membership 0/1/多查询行为。它们仍不覆盖真实平台 session cookie、端到端显式 consent、在线撤销传播或真实 WorkBuddy 换票。

服务端与协议测试当前固定使用官方 `@modelcontextprotocol/sdk` 1.30.0；升级协议或迁移到该 SDK 后续拆分包前，必须重新执行本节协议测试和目标 WorkBuddy 客户端验证。

本批验收包含官方文档/RFC 交叉审查、非秘密 Connector 元数据/Skill 静态核对、四工具本地协议测试、Connector OAuth 正负测试、OAuth/onboarding 数据仓储测试，以及第三方应用 authorize/换票/state/HMAC 身份桥接的本地测试材料核对；没有执行真实第三方应用换票、远程 OAuth、生产部署或真实 WorkBuddy 客户端测试。后续实机测试至少必须保存以下脱敏证据：

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
13. 把浏览器 A 发起的合法 callback 转发给已登录的浏览器 B、切换平台账号后回调、session 轮换/过期后回调均在换票前失败；错误 callback 同样一次性消费 state。
14. callback 的重复 code/state、额外敏感参数、缺少 session cookie、已消费 state 和同一 code 的并发请求全部失败，页面、历史、referrer 和日志不残留参数值。
15. 相同 WorkBuddy 主体并发绑定同一用户保持幂等，绑定不同用户 fail closed；同一平台用户绑定第二个 WorkBuddy 主体按首版一对一策略拒绝，不自动创建、合并或转绑账号。
16. 0/1/多 active memberships 分别验证不签发、明确 consent 和安全选择；在 consent 后、换票前以及持 token 调用前撤销 membership 都会被拒绝。
17. 断开 Connector、解除外部身份、撤销 consent、退出商家和停用账号后，旧 refresh token 与尚未过期的 access token 都立即失败；Skill 关闭不被误当作撤销。

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
- [RFC 10017 OAuth 2.0 for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017.html)
- [Model Context Protocol 官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
