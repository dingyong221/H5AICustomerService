# H5 AI客服生成与管理平台：设计索引

## 当前实现与发布边界（2026-09-25）

仓库已形成运营 Web 开通商家与生成领取/管理链接、商家 Web 领取并创建/确认/发布客服、MySQL 事实仓储、异步 Worker 回答和消费者 H5 咨询的本地闭环。CI 使用一次性 MySQL、受控测试模型与生产构建，在独立主机根路径及 `/ops`、`/console` 子路径变体下分别跑通浏览器场景；候选同域名网关也在隔离端口验收。这证明仓库中的流程，不证明正式模型或生产可用。最新提交的 CI 和仓库证据应以[草稿 PR](https://github.com/dingyong221/H5AICustomerService/pull/1)的精确 SHA 验证记录为准；候选镜像尚未推送。

WorkBuddy 接入已按用户决定暂停，不属于当前 Web 发布范围。OAuth/MCP 代码尚不可宣称接通；候选公网网关对相关路径返回 404，商家 Web 导航也不再展示 WorkBuddy 入口。日后启用需单独完成真实客户端验收。

腾讯云实例、安全组、SSH、主机基线和域名 HTTP 维护入口已完成。按用户批准的单机例外，服务器已装 MySQL 8.4.11、项目库与最小权限账号，未开放公网 3306；生产 Schema、离机备份/PITR、正式 TLS、五个业务容器和真实模型仍未部署或验收。服务器状态须在发布前重新检查，不能把此处或[只读预检](../operations/2026-09-25-production-preflight.md)当作实时状态。仓库标准版本与生产可用状态的权威口径见[发布清单](../release/v0.1.0-standard-release-checklist.md)。

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
| 生产部署 | 原设计托管数据服务优先；本项目经用户批准采用服务器本机 MySQL 单机例外，须补齐离机备份、恢复和故障域风险验收；P0不自建Kubernetes，Ubuntu方案使用Docker Compose + Nginx |

## 设计使用规则

- 需求中的“已明确”是硬约束；“建议基线”只有评审后才进入开发基线；“待确认”不得当作已承诺功能。
- `11-adr-mysql-storage.md`、`10-overall-system-architecture.md`和本索引中的统一结论优先于各专业文档早期的 PostgreSQL/pgvector 局部建议。
- P0目标是形成可试用闭环，P1/P2只保留清晰扩展边界，不提前实现。
- 开发前必须为租户上下文、匿名凭据、发布快照、消息幂等、可靠任务和WorkBuddy接入形成ADR或实测结论。

## 下一阶段输入

当前本地运营→商家→消费者闭环之后仍需完成：

1. 优先完成运营 Web 开通商家、商家 Web 配置与发布、消费者 H5 咨询的正式闭环；WorkBuddy 暂停，不作为本阶段发布前提，其公网入口须保持关闭。
2. 确定正式域名是同域名 `/ops`、`/console`、`/a`、`/api`，还是独立子域名；镜像构建路径、管理链接、Nginx 与 Cookie/回调必须一致。[路径构建变体](../operations/web-path-builds.md)只有本地/CI 验证。
3. 经授权取得正式 TLS、推送/验签五个不可变镜像、配置正式模型与受限 Secret、完成生产 Schema 迁移前的离机备份/PITR、隔离恢复、容量与告警验收。
4. 完成 Staging 同 digest 验收、发布审批、生产切流与回滚演练后，逐项验证平台后台、商家管理链接、消费者固定链接和真实回答；未完成前保持生产 No-Go。

当前需要产品负责人答复的事项包括正式路由、证书申请与通知邮箱、候选镜像推送、离机备份目标、正式模型凭据及试点发布审批；这些选择不由 CI 测试代替。WorkBuddy 凭据暂不需要。
