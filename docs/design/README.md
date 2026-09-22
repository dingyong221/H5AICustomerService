# H5 AI客服生成与管理平台：设计索引

## 本轮结果

项目已从设计进入 `v0.1.0` 仓库标准版本收口：完成了 WorkBuddy/OAuth 安全边界、MySQL 授权与客服草稿/Release 事实仓储、商家端授权与管理客户端、消费者公开 H5 客户端，以及可生成 SBOM/源码哈希证据的发布门禁。管理/Public API、真实生成与回答运行时仍未贯通，因此客户端在缺少可信后端时保持不可用状态，不展示模拟成功。

腾讯云实例、安全组、SSH、主机基线和域名 HTTP 维护入口已按 `05-server-deployment-release.md` 完成；业务容器、托管数据库、真实 WorkBuddy、正式模型和 TLS 尚未部署。仓库标准版本与生产可用状态的权威口径见 `docs/release/v0.1.0-standard-release-checklist.md`。

## 建议阅读顺序

1. [`00-work-division.md`](./00-work-division.md)：任务边界、协作规则和总体任务职责。
2. [`10-overall-system-architecture.md`](./10-overall-system-architecture.md)：统一架构、系统边界、技术基线、数据关系、核心流程和交付阶段。
3. [`11-adr-mysql-storage.md`](./11-adr-mysql-storage.md)：MySQL 事实存储、租户约束、任务、检索派生层和恢复门禁；取代此前 PostgreSQL/pgvector 专用假设。
4. [`01-product-domain-and-ux.md`](./01-product-domain-and-ux.md)：范围、角色权限、信息架构、流程、页面状态和验收场景。
5. [`02-backend-data-ai.md`](./02-backend-data-ai.md)：领域模型、API、发布、知识、RAG、Session、一致性、任务和存储。
6. [`03-frontend-systems.md`](./03-frontend-systems.md)：商家后台、消费者H5、运营端、流式交互、Session恢复和移动端兼容。
7. [`04-platform-security-delivery-skill.md`](./04-platform-security-delivery-skill.md)：部署、安全、审计、隐私、可观测性、CI/CD、测试和WorkBuddy接入。
8. [`05-server-deployment-release.md`](./05-server-deployment-release.md)：服务器与网络、Linux基线、容器、Nginx、数据服务、发布回滚、备份恢复、容量成本和运维Runbook。

## 已统一的架构基线

| 主题 | 统一结论 |
| --- | --- |
| 首版形态 | TypeScript单仓库；三个独立Web应用；模块化单体API；独立Worker |
| Web应用 | `merchant-web`、`consumer-h5`、`ops-web` |
| API命名 | `/api/v1/public`、`/api/v1/merchant`、`/api/v1/ops`、`/api/v1/skill` |
| 数据与检索 | MySQL InnoDB 为业务真值；向量索引为可重建派生层；对象存储保存文件 |
| 可靠任务 | MySQL Transactional Outbox + Job表是真值；Redis只作短期信号、缓存、限流和短锁 |
| 发布 | Release不可变；`active_release_id`原子切换；回滚重新激活完整历史Release并新增审计 |
| Session | `merchant + assistant + visitor credential + release`共同确定归属；公开slug不是会话凭据 |
| 对话 | 同一Session一次只处理一个生成Turn；幂等键和数据库序号防重复与乱序 |
| WorkBuddy | 核心契约是HTTPS REST管理API + 受控商家凭据；MCP/OAuth/分发均须目标环境实机验证 |
| 生产部署 | 托管数据服务优先；至少两个API故障单元与独立Worker；P0不自建Kubernetes；Ubuntu便携方案使用Docker Compose + systemd + Nginx |

## 设计使用规则

- 需求中的“已明确”是硬约束；“建议基线”只有评审后才进入开发基线；“待确认”不得当作已承诺功能。
- `11-adr-mysql-storage.md`、`10-overall-system-architecture.md`和本索引中的统一结论优先于各专业文档早期的 PostgreSQL/pgvector 局部建议。
- P0目标是形成可试用闭环，P1/P2只保留清晰扩展边界，不提前实现。
- 开发前必须为租户上下文、匿名凭据、发布快照、消息幂等、可靠任务和WorkBuddy接入形成ADR或实测结论。

## 下一阶段输入

仓库基线之后仍需完成以下产品闭环：

1. 将平台登录、授权事务、管理/Public API 接到现有可信客户端与 MySQL 仓储。
2. 实现可重复验收的生成协调器、匿名访客 Session/Turn/Message 与确定性本地回答适配器。
3. 建立可销毁 MySQL 的单入口浏览器/API/MCP 验收和同 commit 证据包。
4. 在另行授权后接入真实 WorkBuddy、托管私网 MySQL、正式模型、TLS 与镜像发布链。

在上述产物中，最先需要产品负责人确认的是：首批行业、登录方式、会话超时与留存、联系渠道、模型/部署、试点额度，以及目标WorkBuddy版本与可用接入能力。
