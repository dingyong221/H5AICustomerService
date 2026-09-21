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

## 尚未完成且阻止发布的内容

- 缺少官方要求的 `icon.svg`/`icon.png`/`icon.jpg`，也未准备隐私、权限用途、支持与撤销说明等审核材料。
- 没有实现 OAuth 元数据、动态注册、授权、换票或撤销端点；运行时仍使用不可用认证器，因此受保护工具会返回稳定错误而不会假成功。
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

## 官方依据

- [WorkBuddy 开放平台：技能](https://open.workbuddy.cn/docs/skill)
- [WorkBuddy 客户端：技能](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
- [WorkBuddy 开放平台：连接器](https://open.workbuddy.cn/docs/connector)
- [WorkBuddy 开放平台：第三方应用](https://open.workbuddy.cn/docs/third-party-app)
- [WorkBuddy 开放平台：Open API](https://open.workbuddy.cn/docs/openapi)
- [Model Context Protocol 官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
