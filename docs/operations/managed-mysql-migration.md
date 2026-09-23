# 托管 MySQL 迁移执行边界

此入口只用于已经批准的 Staging/Production 托管私网 MySQL，不负责创建云实例、账号、备份或 Secret。生产应用机不得安装 MySQL 服务，3306 不得开放公网。

## 前置条件

- 使用独立的迁移账号，而非 API/Worker 日常账号；从受控 Secret 注入 `MYSQL_MIGRATION_DATABASE_URL`，不要把连接串放进命令行、聊天、仓库或日志。
- URL 主机必须是证书匹配的私网 DNS 名称，带 `?ssl-mode=VERIFY_IDENTITY`；`MYSQL_TLS_CA_FILE` 指向容器/主机内绝对路径的可信 CA 文件。迁移程序会将 CA、`rejectUnauthorized: true` 和主机名校验传给 MySQL 驱动，并核对实际连接的 `Ssl_cipher`。
- 发布 Compose 的 `H5CS_MYSQL_CA_HOST_FILE` 指向主机上由管理员核对并保护完整性的 CA PEM；API、Worker、商家 Web 和运营 Web 将它只读挂载为 `/etc/ssl/certs/h5cs-managed-mysql-ca.pem`。镜像以非 root 的 `node` 用户运行，主机上的 CA 文件应为 `root:root`、权限 `0644`，其父目录须可遍历；CA 证书是公开信任材料，不是私钥。迁移命令若在其他执行环境运行，应使用该环境可读取的绝对路径；不得把 CA 文件烘入公开镜像或用关闭证书验证代替挂载。
- 先在 Staging 以同一代码提交和迁移清单演练。生产执行前确认全量备份与 binlog/PITR 可用、隔离恢复已验证，并准备变更单和回滚方案。MySQL DDL 不保证事务式回滚，脚本失败后不得盲目重试。
- 在能访问私网数据库的受控执行环境运行。当前生产服务器尚无托管 MySQL，因此此文档不是已执行证明。

## 两步执行

先在仓库对应的不可变代码版本中读取离线迁移清单：

```text
pnpm --filter @h5cs/database db:migrate:managed --inventory
```

核对文件顺序及输出的 `planSha256`。这只是文件清单，不代表数据库待应用项或数据库连接成功。

由受控运行环境设置 `APP_ENV=staging` 或 `production`，以及上述迁移连接变量。生产额外设置不含秘密的 `H5CS_MIGRATION_BACKUP_REF` 和 `H5CS_MIGRATION_CHANGE_ID`。确认目标主机、库名和清单哈希后执行：

```text
pnpm --filter @h5cs/database db:migrate:managed --apply --target=staging --expect-host=<私网DNS名> --expect-database=<库名> --accept-plan-sha256=<64位清单哈希>
```

生产时将 `--target` 改为 `production`，其余确认项必须来自生产变更单。脚本会再次比对清单哈希、配置环境、目标主机/库名、实际选中数据库和 TLS 协商结果，取得数据库迁移锁后由 Drizzle 在单一连接上应用尚未记录的迁移。

执行后以同一受控账号只读核对 `__drizzle_migrations`、实际 Schema 和应用健康，再进行业务冒烟。失败时先核对迁移记录与实际 Schema；若出现部分 DDL，按恢复预案处理，不把再次执行命令当成回滚。
