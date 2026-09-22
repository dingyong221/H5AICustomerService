# 研发阶段索引

当前研发目标是建立一个可持续演进、可测试、可容器化的首个纵向切片，而不是用静态页面伪装完整产品。

## 当前里程碑：M1 仓库标准版本基线

- TypeScript/pnpm/Turbo 单仓库可安装、检查和构建。
- API、Worker、商家后台、消费者 H5、运营后台均有独立可运行入口。
- MySQL Schema 从第一张表开始包含租户归属和必要复合约束。
- 本地 MySQL/Redis 只监听 loopback；Secret 不进入 Git 或镜像。
- API 健康检查区分进程存活和外部依赖就绪，不伪造数据库状态。
- 三端在没有后端数据时显示真实空状态/未连接状态。
- CI 能执行格式、类型、测试和构建门禁。
- WorkBuddy/OAuth 授权数据、平台登录会话和在线绑定复核已有 MySQL 仓储与失败关闭适配器。
- 客服草稿、不可变 Release、活动 Release 切换和公开快照已有事务化 MySQL 仓储。
- Merchant Web 与 Consumer H5 已有严格同源、信封校验、CSRF/幂等/ETag 与安全轮询客户端。
- 发布门禁可检查秘密、依赖、Compose、格式、Lint、类型、测试、构建、SBOM、源码哈希和生产证据。

## 后续里程碑

1. M2：接通受保护管理/Public API、生成协调器，以及消费者凭据、Session、单活 Turn 和 Message。
2. M3：增加本地 MySQL + WorkBuddy 模拟器的单入口端到端验收，形成产品 `local_candidate`。
3. M4：知识任务、派生检索索引、可追溯回答、反馈、运营审计与用量。
4. M5：在获授权后构建签名镜像并部署 Staging，接入托管 MySQL、真实 WorkBuddy、正式模型与 TLS。

## 权威设计

- 总体架构：`docs/design/10-overall-system-architecture.md`
- MySQL ADR：`docs/design/11-adr-mysql-storage.md`
- 后端/数据/AI：`docs/design/02-backend-data-ai.md`
- 前端系统：`docs/design/03-frontend-systems.md`
- 平台安全与交付：`docs/design/04-platform-security-delivery-skill.md`
- 服务器部署：`docs/design/05-server-deployment-release.md`

任何实现与 MySQL ADR、租户隔离或公网暴露约束冲突时，先停止实现并修正文档/代码，不以赶进度为理由绕过门禁。
