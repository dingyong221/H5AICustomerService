# 发布与回滚 Runbook

> 本文是执行模板，不授权生产写入。真实发布必须先满足 `docs/release/v0.1.0-standard-release-checklist.md` 的生产门禁，并取得当次变更授权。

## 1. 角色与不可变输入

至少指定发布执行者、独立复核者、业务验收人和事故负责人。发布前冻结并记录：

- `candidate` 与 `previous` 的 Git commit、API/Worker/三端 Web digest、静态制品 SHA-256、配置版本和数据库兼容区间；
- release manifest、CycloneDX SBOM、依赖审计、签名和 provenance 的校验引用；
- Staging 同 digest 验收、备份/恢复演练、告警送达、维护窗口、停止条件和变更单；
- 精确回滚目标 `previous`，禁止使用 `latest`、现场重新构建或临时 `git pull`。

Release evidence、审批记录和探针结果不得包含 Secret、Token、Cookie、数据库连接串、私钥或预签名 URL。

## 2. 发布前验证

1. 在干净 checkout 执行 `pnpm install --frozen-lockfile` 和 `node scripts/quality/release-gate.mjs repository --version 0.1.0`。
2. 生成并离线复核 SBOM、source hashes、release manifest 和 `evidence.sha256`；校验 commit 与 tag。
3. 使用 `infra/compose/release.env.example` 的同结构脱敏 locator 文件运行 release Compose `config --quiet`；五个 `H5CS_*_IMAGE` 必须是 registry `@sha256:` 引用。随后对每个镜像执行 registry digest、签名和 provenance 验证；基础镜像与运行镜像均不得依赖浮动 tag。
4. 在 Staging 部署相同 digest，验证 `/startupz`、`/livez`、`/readyz`、SSE、Job、租户隔离、幂等、审计与真实外部依赖。
5. 验证 MySQL 备份/PITR、Schema expand 兼容、metadata lock 风险和旧应用兼容；迁移失败不自动向下迁移。
6. 运行 production evidence gate。命令非零时停止：

```text
node scripts/quality/release-gate.mjs production --version 0.1.0 --evidence <approved-production-evidence.json>
```

## 3. current → candidate 切流

1. 保存切流前路由、运行实例、配置引用、Job 领取状态和关键指标快照。
2. 先部署 candidate，不接公网流量；只使用私网/本机探针验证启动和依赖。
3. 若有 expand 迁移，由独立 migrator 执行；API/Worker 不自行竞争迁移。
4. 先切极小比例或单个受控测试商家；观察 5xx、P95、SSE 断开、Job 失败、MySQL 锁/复制、Token/consent 错误和跨租户告警。
5. 每一档扩流都需要复核者确认；任何停止条件触发就停止扩大并进入第 4 节。
6. 全量稳定后排空 previous，但不删除 previous 镜像、静态制品、配置和回滚命令。

## 4. 回滚决策与执行

可直接应用回滚的范围仅限：Schema/事件仍向后兼容，且没有疑似数据损坏、跨租户泄漏、Secret 泄漏或重复计费/重复业务动作。

出现跨租户风险、数据损坏、迁移异常或凭据泄漏时，先停止写入/隔离流量和保存证据，由事故负责人选择 forward fix、PITR 或其他恢复；禁止脚本反复自动切换。

应用回滚顺序：

1. 停止 candidate 扩流和领取新 Job；保留日志、trace、审计和数据库状态证据。
2. 将 Nginx/LB/API/Worker/三端 Web 精确切回已记录的 previous digest 与兼容配置。
3. 不删除 expand 列、表或索引；只有经单独评审的灾难恢复才执行 PITR。
4. 等待 previous readiness 通过后再逐步恢复流量；candidate 保持隔离，禁止原地覆盖。
5. 记录实际开始/结束时间、执行者、命令引用、digest、流量变化、失败原因和后续修复负责人。

## 5. 回滚后业务验证

只看到容器 `running` 或健康端点 200 不算回滚成功。至少验证：

- 消费者 H5 固定链接、静态 buildId、Session 新建/恢复、SSE 和消息幂等；
- 当前 Assistant Release、商家登录、知识 Job、发布/回滚、Usage 对账和审计记录；
- API 与 Worker 使用 previous digest，数据库连接/Schema 兼容、无异常锁或重复 Job；
- WorkBuddy OAuth/身份绑定/商家 consent 的安全失败路径，以及 Token 不混用；
- 5xx、P95、错误率和告警恢复到基线，真实告警关闭有审计理由。

验证失败则保持业务 No-Go，不得因回切动作完成而关闭事故。

## 6. 演练证据最小集

每次演练必须保存以下脱敏信息，并映射到 production readiness JSON：

| 字段                 | 要求                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `exerciseId`         | 唯一、可审计，不含人员隐私或凭据                                                             |
| candidate / previous | 五个部署单元的完整 `sha256:` digest                                                          |
| 时间线               | 开始、故障注入、判定、切回、业务验证完成时间                                                 |
| 数据库               | Schema 兼容结果、备份/PITR 引用；不记录连接串                                                |
| 验证                 | 核心冒烟、租户隔离、SSE、Job、Usage、审计和告警结果                                          |
| 人员                 | 执行、复核、业务验收、事故负责人及变更单引用                                                 |
| 结论                 | `applicationRollbackDrillPassed`、`databaseCompatibilityVerified`、`postRollbackSmokePassed` |

首次生产前、破坏兼容性的重大变更前，以及 previous 制品或编排方式变化后，都必须重新演练。
