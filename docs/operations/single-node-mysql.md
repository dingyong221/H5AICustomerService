# 项目单机 MySQL 运行记录

2026-09-25 项目负责人批准在 `114.132.92.111` 安装生产 MySQL，并随后批准创建项目专用库、最小权限账号和服务器本地受限凭据。这是托管私网数据库方案的单机例外，不是高可用或已可恢复的证明。生产数据写入前须完成离机备份、隔离恢复演练、容量告警及正式变更确认。

## 当前部署

- 服务器：`h5-ai-customer-service-prod`，Ubuntu 22.04，2 vCPU / 8 GiB / 50 GiB 根盘。
- MySQL：8.4.11，官方 AMD64 镜像摘要 `sha256:f015b98a954d6bb92c370d93f354b85f4bcea15642d9fb2975f841a00d400b65`，从腾讯云镜像源按摘要获取；部署前与 Docker Hub 官方同版本 AMD64 摘要交叉核对。
- 容器/卷：`h5cs-prod-mysql`、`h5cs_mysql_prod_data`；独立 `h5cs_prod_data_internal` 内部 Docker 网络，DNS 别名 `mysql.h5cs.internal`；没有宿主机 3306 端口映射，安全组和 UFW 均不得添加 3306。
- 数据库：`h5_ai_customer_service_prod`，`utf8mb4` / `utf8mb4_0900_ai_ci`；UTC；InnoDB；binlog 已启用、保留 7 天。binlog 留在同一卷，不能替代离机 PITR 归档。
- 身份：`h5cs_migrator` 只在项目库有 DDL/DML；`h5cs_api`、`h5cs_worker`、`h5cs_ops_web`、`h5cs_merchant_web` 只在项目库有 SELECT/INSERT/UPDATE/DELETE；`h5cs_readonly_ops` 只有 SELECT。均要求 SSL。不要复用其他项目账号。
- TLS：本项目专用本地 CA 签发服务证书，SAN 为 `mysql.h5cs.internal`；服务器要求加密传输。测试客户端已用 `VERIFY_IDENTITY` 成功连接并协商 TLS 1.3 密码套件。CA 私钥只在服务器受限目录，不进入数据库容器、镜像或 Git。
- 配置文件：`/opt/h5-ai-customer-service/mysql/`；随机凭据与证书：`/etc/h5-ai-customer-service/mysql/`，仅 root 和数据库容器必要身份可读。禁止在命令行、日志、聊天或仓库输出密码/连接串。

## 检查与停止边界

以项目独立 SSH 别名登录后，使用 `sudo docker compose -f /opt/h5-ai-customer-service/mysql/docker-compose.mysql-single-node.yml ps` 和 `sudo /opt/h5-ai-customer-service/mysql/verify-single-node-mysql.sh` 检查。SSH 超时须先按 `AGENTS.md` 核对当前出口与专属安全组，不能开放 22 到公网任意来源。不要将本机 MySQL 容器混入业务蓝绿 Compose 项目；业务发布时只通过 `docker-compose.release.single-node-mysql.yml` 附加内部数据网络。业务环境中的 `MYSQL_DATABASE_URL` 使用 `mysql.h5cs.internal` 与 `?ssl-mode=VERIFY_IDENTITY`，CA 文件取本项目的 `/etc/h5-ai-customer-service/mysql/certs/ca.pem`，不使用宿主机回环 IP 或公网地址。

手动本地逻辑备份使用 `sudo /opt/h5-ai-customer-service/mysql/backup-single-node-mysql.sh`，产物在 `/var/backups/h5-ai-customer-service/mysql/`，仅 root 可读，附 SHA-256 校验文件。用 `sudo /opt/h5-ai-customer-service/mysql/restore-test-single-node-mysql.sh /var/backups/h5-ai-customer-service/mysql/<备份文件>.sql.gz` 可在无网络、临时内存盘的隔离容器内验证逻辑导入；它不触碰生产卷。该备份位于同一根盘，不能充当离机备份或已演练的 PITR；未配置自动备份与安全的保留清理策略前，不要把它当作无人值守恢复机制。

首次安装后建立了本地基线备份 `h5cs-prod-20260925T043309Z.sql.gz`（600 字节，空业务 Schema），SHA-256 校验通过，并在隔离容器中成功导入、确认目标库存在。此时表数为 0，因此该演练只验证备份/导入链路，不证明未来业务数据可恢复；正式 Schema 和数据写入后必须重新演练并做记录数、租户、Release、Job、Usage 对账。

目前仅完成数据库服务和账号的基础安装与 TLS/网络验证。尚未执行生产 Schema 迁移，也未接入业务、离机备份、PITR 或正式流量。根盘只有 50 GiB，MySQL、应用镜像和备份会争用同一故障域；备份不能只留在本机。若磁盘或数据库异常，先停止写入并保全卷和日志，不得盲目重建容器、删除卷或重跑初始化脚本。`provision-single-node-mysql.sh` 只用于空卷首次安装，检测到现有容器/卷会拒绝重跑。
