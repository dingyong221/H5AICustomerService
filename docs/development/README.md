# 研发阶段索引

当前研发目标是建立一个可持续演进、可测试、可容器化的首个纵向切片，而不是用静态页面伪装完整产品。

## 当前里程碑：M0 工程骨架

- TypeScript/pnpm/Turbo 单仓库可安装、检查和构建。
- API、Worker、商家后台、消费者 H5、运营后台均有独立可运行入口。
- MySQL Schema 从第一张表开始包含租户归属和必要复合约束。
- 本地 MySQL/Redis 只监听 loopback；Secret 不进入 Git 或镜像。
- API 健康检查区分进程存活和外部依赖就绪，不伪造数据库状态。
- 三端在没有后端数据时显示真实空状态/未连接状态。
- CI 能执行格式、类型、测试和构建门禁。

## 后续里程碑

1. M1：商家创建客服草稿、FAQ 和不可变 Release。
2. M2：消费者凭据、Session、单活 Turn 与 SSE 占位链路。
3. M3：知识任务、派生检索索引、可追溯回答与反馈。
4. M4：运营审计、用量、异常处置、发布回滚与安全测试。
5. M5：镜像发布到预发布环境，接入托管 MySQL/Redis/对象存储和正式 TLS。

## 权威设计

- 总体架构：`docs/design/10-overall-system-architecture.md`
- MySQL ADR：`docs/design/11-adr-mysql-storage.md`
- 后端/数据/AI：`docs/design/02-backend-data-ai.md`
- 前端系统：`docs/design/03-frontend-systems.md`
- 平台安全与交付：`docs/design/04-platform-security-delivery-skill.md`
- 服务器部署：`docs/design/05-server-deployment-release.md`

任何实现与 MySQL ADR、租户隔离或公网暴露约束冲突时，先停止实现并修正文档/代码，不以赶进度为理由绕过门禁。
