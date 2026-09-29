# 2026-09-29 生产空库本机备份预演

本记录只验证当前空库的本机逻辑备份与隔离恢复流程；**不代表**离机备份、生产数据恢复或发布门禁已经完成。

- 目标：`114.132.92.111` 上的 `h5cs-prod-mysql` / `h5_ai_customer_service_prod`。执行前后均为 **0 张业务表**；MySQL 容器健康。
- 使用仓库 `scripts/operations/backup-single-node-mysql.sh` 生成 `/var/backups/h5-ai-customer-service/mysql/h5cs-prod-20260929T054837Z.sql.gz`；文件为 601 字节、`0600` 权限。`gzip -t` 与 SHA-256 校验文件均通过，摘要为 `11a8f652b38135475782e93300a904d74a6ba5ca2b6a3b59a7624131d486cd07`。
- 使用仓库 `scripts/operations/restore-test-single-node-mysql.sh`，在 `--network none`、内存盘和禁用网络连接的临时 MySQL 容器中恢复；第二次执行的退出码为 0，恢复库名正确，表数为 0。临时容器已移除。
- 演练期间公网 `/ops` 返回 `503`，没有运行生产 Schema 迁移或切换业务流量。

当前备份与生产数据位于同一台服务器，不能覆盖整机故障、云盘损坏或误删。库中尚无真实业务数据，因此也没有证明含商户、知识和会话数据的生产恢复能力。正式写入真实数据和切流前，仍须明确离机备份及恢复策略，并完成生产迁移、监控告警和回滚门禁。
