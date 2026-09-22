# H5 AI Customer Service

H5 AI 客服生成与管理平台的 TypeScript 单仓库。当前版本为 `v0.1.0` 仓库标准版本候选：工程、授权、MySQL 事实层、商家端/消费者端可信客户端和发布门禁已形成可重复验证的基线；真实外部依赖未配置时，生产运行时保持失败关闭。

> “仓库标准版本”不等于“生产业务已上线”。当前服务器仍是 HTTP 维护入口；真实 WorkBuddy、托管私网 MySQL、正式模型、TLS、镜像仓库与生产演练完成前，不得把本版本标记为生产可用。

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
