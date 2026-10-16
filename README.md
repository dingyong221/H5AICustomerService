# H5 AI Customer Service

H5 AI 客服生成与管理平台的 TypeScript 单仓库，工程版本基线为 `v0.1.0`。现有受控 Web 试用站已完成运营开通、独立商家后台、文字资料确认、千问试聊与发布、消费者 H5 对话、资料填写助手和帮助中心；运行版本与验收见[2026 年 10 月 6 日发布记录](docs/operations/merchant-help-writing-release-2026-10-06.md)。

> 当前是受控试用，不是全面正式商用就绪。MySQL 按负责人批准使用同机私网例外，正式域名已启用 TLS 和千问；WorkBuddy 直连、离机备份及完整生产保障仍未完成。R1 持续改善功能处于候选验收阶段，尚未切换公网，不以已有小闭环代替新版本验收。

## 持续改善候选

R1 围绕“原咨询发现问题 → 商家确认 FAQ 修正 → 原题复测 → 人工判定 → 发布追溯”，同时补充人工联系说明和资料缺项提醒。它不自动学习、不自动发布，不以调用成功声称问题解决或计算准确率。

- [竞品研究与 P0/P1/P2 路线](docs/product/continuous-product-research-2026-10-17.md)
- [首轮页面、业务和数据设计](docs/design/21-merchant-improvement-loop.md)
- [商家持续改善使用指南](docs/product/merchant-improvement-user-guide.md)
- [实际验收记录](docs/operations/2026-10-17-improvement-candidate-evidence.md)
- [受控 Web 变更方案和回退边界](docs/operations/2026-10-17-r1-controlled-change-plan.md)

## 工作区

- `apps/api`：管理、公开、运营和 Skill REST/SSE API。
- `apps/worker`：知识处理、派生索引、Outbox 和持久 Job Worker。
- `apps/merchant-web`：商家后台。
- `apps/consumer-h5`：消费者移动 H5。
- `apps/ops-web`：平台运营后台。
- `packages/contracts`：跨应用 API、事件和错误契约。
- `packages/domain`：不依赖框架的领域类型与规则。
- `packages/database`：MySQL/Drizzle Schema、迁移和 Repository 基础。
- `packages/ui`：管理端共享 UI 基础。
- `packages/config`：共享工程配置。

## 本地要求

- Node.js 24+
- pnpm 11+
- Docker Desktop 或兼容的 Docker/Compose（运行本地 MySQL、Redis）

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm release:static
pnpm release:check
```

`release:check` 必须在 Node.js 24 下运行，并要求 Docker Compose 与 Bash；Windows 也可通过发布清单记录的独立 Compose/ShellCheck 路径执行同等校验。

版本说明见 [`CHANGELOG.md`](CHANGELOG.md) 和 [`docs/release/v0.1.0-release-notes.md`](docs/release/v0.1.0-release-notes.md)。架构与安全边界见 [`docs/design/README.md`](docs/design/README.md)，MySQL 权威决策见 [`docs/design/11-adr-mysql-storage.md`](docs/design/11-adr-mysql-storage.md)。生产环境不得把 MySQL、Redis、Docker API 或应用内部端口暴露到公网。
