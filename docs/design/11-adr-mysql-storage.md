# ADR-003：MySQL 作为业务事实存储

- 状态：已采纳
- 决策日期：2026-09-21
- 决策来源：项目负责人明确指定“存储使用 MySQL”
- 取代范围：此前设计中的 PostgreSQL、pgvector、PostgreSQL RLS、JSONB、GIN、tsvector、WAL/vacuum 和 advisory lock 专用假设

## 1. 决策

平台采用 **MySQL InnoDB** 作为业务事实数据库。商家、客服、草稿、Release、知识元数据、Session、Message、Lead、Usage、Audit、Transactional Outbox 和持久 Job 均以 MySQL 为权威真值。

Redis 继续只承载限流、短锁、短期流事件和可重建缓存；S3 兼容对象存储保存文件原件和大体积派生物；向量索引是可重建派生存储，不再默认使用 pgvector，也不得成为知识原文、Release 或租户归属的唯一真值。

生产优先使用同地域、私网可达、支持高可用、TLS、自动备份和 binlog 时间点恢复的托管 MySQL。当前 `114.132.92.111` 是应用/网关节点，不在该 2 vCPU、8 GiB、50 GiB 根盘上安装生产 MySQL，除非项目负责人另行批准临时单机方案并接受单故障域、资源争用和恢复风险。

具体 MySQL 版本在云产品选定后锁定；候选版本必须仍在安全支持期，并通过本 ADR 所列能力验证。应用与迁移不得依赖未在目标实例验证的厂商扩展。

## 2. 数据建模约束

1. 所有租户资源都显式包含 `merchant_id`；客服级资源同时包含 `assistant_id`。Repository 不接受裸资源 ID，必须接收 `TenantContext`。
2. 跨表归属通过复合主键/唯一键与复合外键尽可能下沉到 InnoDB；ORM 无法表达时使用显式迁移 SQL，不能降级为仅靠请求层判断。
3. MySQL 没有 PostgreSQL RLS 等价兜底。必须用 Repository 强制上下文、最小权限数据库账号、复合约束、越权负向测试和审计共同补偿；高隔离客户可评估独立数据库/实例。
4. 字符集统一使用 `utf8mb4`；排序规则必须在建库时锁定并覆盖中文、英文、数字和大小写唯一性测试，不能依赖开发机默认值。
5. 时间统一存 UTC，使用支持微秒精度的时间列；展示时在应用层转换时区。金额、Token 和计数使用定点/整数类型，不使用浮点数。
6. UUID/ULID 等 ID 的物理格式在 Schema ADR 中确定；若使用 UUID，优先评估紧凑二进制存储和有序生成，避免随机文本主键导致聚簇索引膨胀。
7. 结构化扩展字段可使用 MySQL `JSON`，但查询热点必须提升为普通列或生成列并建立可验证索引；禁止把核心约束藏在不可索引 JSON 中。
8. 软删除、状态、版本号、幂等键和审计时间均有明确列和索引；唯一约束必须验证 MySQL 对 `NULL`、排序规则和软删除组合的实际语义。

## 3. 事务、任务与并发

- 业务写入、Outbox 事件和 Job 创建在同一 MySQL 事务提交，避免“业务已成功但任务丢失”。
- Worker 使用短事务领取任务，采用租约字段、确定性排序、覆盖索引和目标 MySQL 已验证的 `SELECT ... FOR UPDATE SKIP LOCKED` 能力；领取后立即提交，不持有数据库事务执行模型、文件或网络调用。
- 在压测中比较 `READ COMMITTED` 与默认隔离级别的锁等待、gap lock、重复领取和饥饿行为，再锁定 Worker 会话隔离级别。不能从 PostgreSQL 行锁设计直接照搬。
- 同一 Session 保持单活 Turn；序号分配、状态转换、幂等键和 UsageReservation 在事务内受行锁/乐观版本保护。
- 迁移使用专门的迁移历史表和有界互斥锁。若采用 MySQL named lock，必须处理连接断开、超时和非事务生命周期，不能假设其等同于 PostgreSQL transaction-scoped advisory lock。
- 所有外部副作用由提交后的 Outbox/Job 驱动；消费者至少一次执行且必须幂等。

## 4. 检索与 AI 数据边界

MySQL 保存：知识来源、不可变修订、Chunk 正文/对象引用、租户与 Release 归属、Embedding 模型和版本、索引批次、校验和及派生索引引用。

向量召回有两类候选实现，必须通过同一租户过滤、召回质量、P95、成本和恢复测试后选定：

1. 云厂商或 MySQL 生态提供且目标实例实际支持的向量能力；不得仅凭产品名称推断兼容。
2. 独立托管向量检索服务。索引记录必须携带 `merchant_id + assistant_id + knowledge_revision/release`，查询强制带租户与版本过滤；全部索引可从 MySQL 和对象存储重建。

关键词检索优先对 MySQL InnoDB FULLTEXT 的中文 ngram 能力做真实语料 PoC；若行业词、同义词和混合排序不达标，再采用独立搜索服务。最终回答仍须回到 MySQL 校验租户、Release、修订状态和有效期，不能仅信任派生索引返回结果。

## 5. 运行与恢复基线

- MySQL 仅经私网或批准的服务间网络访问，默认端口 3306 不加入公网安全组或 UFW。
- API、Worker、Migrator 使用分离账号和最小权限；连接强制 TLS，Secret 通过受控 Secret 管理注入，不进入 Git、镜像或前端。
- 生产要求托管高可用、自动快照、binlog/PITR、存储扩容和恢复到隔离实例的能力；Redis 丢失不影响业务真值。
- 备份完成不等于可恢复。上线前必须演练指定时间点恢复、租户/Release/Job/Usage 对账、对象引用校验和向量/全文索引重建。
- 核心监控包括连接池、事务、锁等待/死锁、慢查询、buffer pool、复制/故障转移、binlog/PITR、磁盘/IOPS 和容量增长。
- Schema 继续采用 expand → 回填 → 切换 → contract；破坏性 DDL、长时间表重建和大批量回填必须先在生产同规格数据量上验证。

## 6. PostgreSQL 设计映射

| 原设计能力 | MySQL 决策 |
| --- | --- |
| PostgreSQL 事实库 | MySQL InnoDB 事实库 |
| pgvector | 独立/托管向量派生层，或经 PoC 验证的目标 MySQL 向量能力 |
| PostgreSQL RLS | 复合归属约束 + TenantContext Repository + 最小权限账号 + 越权测试；无等价原生兜底 |
| JSONB + GIN | MySQL JSON + 普通/生成列索引；热点字段结构化 |
| tsvector/GIN | MySQL FULLTEXT ngram PoC；不达标时使用独立搜索服务 |
| WAL/PITR | binlog/PITR + 托管快照 + 隔离恢复演练 |
| advisory lock | 迁移历史表与有界互斥；named lock 仅在验证生命周期后使用 |
| PostgreSQL Job 锁 | MySQL 短事务租约 + 经验证的 SKIP LOCKED + 幂等执行 |

## 7. 编码与部署前门禁

- [ ] 确定托管 MySQL 产品、地域、版本、HA、私网、TLS、备份保留、PITR、容量和费用。
- [ ] 验证目标版本的复合外键、JSON/生成列索引、FULLTEXT ngram、`SKIP LOCKED`、在线 DDL 和连接驱动行为。
- [ ] 完成两租户以上的越权负向测试，证明没有 RLS 时 Repository 和复合约束仍能阻断跨租户读取/写入。
- [ ] 完成 Job 并发领取、崩溃恢复、租约过期、死锁重试和至少一次副作用幂等测试。
- [ ] 用真实中文知识集对 MySQL FULLTEXT、向量候选和混合排序进行召回/准确率/P95/成本评测。
- [ ] 完成 binlog/PITR 隔离恢复演练，并能从 MySQL + 对象存储重建全部派生索引。
- [ ] 3306 从公网不可达；数据库账号、应用网络和 Secret 均按环境隔离。

## 8. 不包含的授权

本 ADR 确定技术方向，不授权购买云数据库、创建实例、开放端口、生成账号/密码、安装本机 MySQL、迁移生产数据或修改当前安全组。上述操作必须在云产品、费用、网络、备份和执行窗口确定后单独实施。
