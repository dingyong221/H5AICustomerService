# H5 AI Customer Service

H5 AI 客服生成与管理平台的 TypeScript 单仓库。当前处于首个可运行骨架建设阶段。

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
pnpm install
pnpm dev
pnpm check
```

架构与安全边界见 [`docs/design/README.md`](docs/design/README.md)，MySQL 权威决策见 [`docs/design/11-adr-mysql-storage.md`](docs/design/11-adr-mysql-storage.md)。生产环境不得把 MySQL、Redis、Docker API 或应用内部端口暴露到公网。
