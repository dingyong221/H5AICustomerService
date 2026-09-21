# WorkBuddy Skill 可审阅源稿

> 状态：仅供产品、安全和 WorkBuddy 接入评审；当前不是可安装、可上传或可发布的成品。

本目录保存 H5 AI 客服的 WorkBuddy Skill 源稿，当前只覆盖两个自然语言入口：

1. **生成 AI 客服**：分步收集真实业务资料，预览并明确确认后，只创建可编辑草稿。
2. **打开已有客服后台**：在服务端已验证用户、商家和权限后，返回对应管理链接。

## 当前目录

```text
integrations/workbuddy/
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

结构遵循 WorkBuddy 官方 Skill 约定：`SKILL.md` 为必选文件，补充说明放在 `references/`。本稿没有脚本和模板。

## 有意留空的接入内容

- 未设置 `allowed-tools`：业务工具名和参数尚未实现、评审和实机验证，不能提前伪造白名单。
- 未创建 `connector-meta.json`、`mcp.json` 或 Connector 图标：MCP 传输、工具 Schema、OAuth 和最低客户端版本尚未完成。
- 未填写 MCP URL、绑定 URL、后台 URL、Client ID、Token 或任何凭据：链接必须由受信服务端在运行时返回，不能在 Skill 中写假地址或秘密。
- 未声明当前包可上传或可发布：官方远程业务服务建议采用 MCP + Skill，但本目录目前只有 Skill 对话源稿。

在 MCP 传输、OAuth、账号绑定和真实 WorkBuddy 客户端验证完成前，**禁止将本目录打包上传、提交审核或对外发布**。

## 未来 Connector 目录清单

以下仅是通过验证后的目标清单，不代表这些文件已经存在：

```text
h5-ai-customer-service-connector/
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

进入实现前至少要确定：

1. 真实工具名、输入输出 Schema、幂等和错误码。
2. 远程 HTTPS MCP 的传输方式、超时和唯一 Server 配置。
3. 本平台 OAuth 2.1 + PKCE、撤销和重新连接流程。
4. 第三方应用 OAuth 返回的 `open_id` 如何在服务端绑定；普通 Skill/Connector 不得被假设会自动取得该标识。
5. 绑定、帮助和后台链接在目标 WorkBuddy 版本中的点击、复制和跨端行为。
6. Skill 自动/手动触发、启用/关闭、误触发和高风险确认的实机结果。
7. 隐私说明、权限用途、支持与撤销入口、版本兼容范围和审核材料。

## 官方依据

- [WorkBuddy 开放平台：技能](https://open.workbuddy.cn/docs/skill)
- [WorkBuddy 客户端：技能](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
- [WorkBuddy 开放平台：连接器](https://open.workbuddy.cn/docs/connector)
- [WorkBuddy 开放平台：第三方应用](https://open.workbuddy.cn/docs/third-party-app)
- [WorkBuddy 开放平台：Open API](https://open.workbuddy.cn/docs/openapi)
