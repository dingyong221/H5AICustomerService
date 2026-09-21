# 本地开发与容器构建

本文只适用于开发工作站。这里的 MySQL、Redis、账号、口令和数据卷都是可丢弃的本地资源，不得复用于共享测试、预发布或生产环境。

## 1. 前置要求

- Node.js 24（以根目录 `.nvmrc` 为准）。
- pnpm 11.19.0（以根目录 `packageManager` 为准）。
- Docker Engine/Desktop 与 Docker Compose v2。
- 可用的 `127.0.0.1:3306` 和 `127.0.0.1:6379`；需要改端口时只修改本机 `.env`。

启用包管理器并确认版本：

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
node --version
pnpm --version
```

## 2. 初始化本地环境

复制示例配置。`.env` 已被 Git 忽略，不要提交它：

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

`.env.example` 中的 `local-dev-*` 口令只用于绑定在 loopback 的一次性开发容器。即使是本地开发，也不要把真实模型密钥、云数据库口令或生产 Cookie/HMAC 密钥写进示例文件。

安装依赖：

```bash
pnpm install --frozen-lockfile
```

当依赖声明确实被评审后发生变化时，由负责依赖集成的人运行一次非 frozen 安装并提交更新后的 lockfile；不要在 CI 中自动改写 lockfile。

## 3. 启动 MySQL 与 Redis

先渲染并检查 Compose 配置：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml config
```

确认端口仍为 `127.0.0.1` 绑定后再启动：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml up -d --wait
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml ps
```

本地 Compose 只启动：

- MySQL 8.4 LTS，`utf8mb4` / `utf8mb4_0900_ai_ci`，宿主机默认为 `127.0.0.1:3306`；
- Redis，启用 AOF 和本地开发口令，宿主机默认为 `127.0.0.1:6379`。

容器不会把 MySQL、Redis、Docker API 或应用端口绑定到工作站的公网网卡。若 `docker compose config` 显示 `0.0.0.0`，停止并修复配置，不要继续启动。

查看健康状态或日志：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml ps
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml logs --tail=100 mysql redis
```

## 4. 向当前终端加载环境变量

Docker Compose 会直接读取 `.env`，但从宿主机运行的 Node/Drizzle 进程需要继承这些变量。

PowerShell：

```powershell
Get-Content .env |
  Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } |
  ForEach-Object {
    $name, $value = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
```

Bash：

```bash
set -a
. ./.env
set +a
```

不要在终端输出完整环境、使用 `set`/`env` 截图，或把包含秘密的命令复制到工单。

## 5. 数据库迁移

MySQL InnoDB 是业务事实库。Redis 和未来的向量索引都不是迁移或恢复来源。

Schema 变更流程：

1. 修改 `packages/database/src/schema/` 下的 Drizzle Schema。
2. 生成迁移并审阅 SQL，特别检查 `merchant_id` 复合唯一键/外键、索引、字符集和排序规则。
3. 在本地 MySQL 应用迁移。
4. 运行类型检查、数据库测试和跨租户负向测试后再提交。

```bash
pnpm --filter @h5cs/database db:generate
pnpm --filter @h5cs/database exec drizzle-kit migrate --config drizzle.config.ts
```

安全边界：

- `MYSQL_DATABASE_URL` 必须指向 `127.0.0.1`/`localhost` 和开发库，执行前先核对主机与库名。
- 本地迁移不得使用生产或共享环境凭据，不得打开 SSH 隧道指向生产数据库。
- 不以 `drizzle-kit push` 代替可审阅、可重复的迁移文件。
- 删除列、删表、全表回填等破坏性操作需要单独评审；本地能成功不代表可直接用于生产。
- MySQL 没有本项目可依赖的 RLS。每个租户 Repository 仍必须接收 `TenantContext`，并在 SQL 和复合约束中包含 `merchant_id`。

## 6. 启动应用

基础设施健康、迁移完成且当前终端已加载 `.env` 后，在仓库根目录运行：

```bash
pnpm dev
```

默认开发入口：

| 进程      | 地址/说明                                                                                   |
| --------- | ------------------------------------------------------------------------------------------- |
| 商家后台  | `http://127.0.0.1:3000`                                                                     |
| 消费者 H5 | `http://127.0.0.1:3001`                                                                     |
| 运营后台  | `http://127.0.0.1:3002`                                                                     |
| API       | `http://127.0.0.1:4000`；`/livez` 只表示进程存活，`/readyz` 才检查依赖就绪                  |
| Worker    | 内部健康端口默认为 `127.0.0.1:3011`；就绪性以 `/readyz`、Job lease/heartbeat 和依赖探针为准 |

单独运行某个工作区时使用其包名或路径过滤，例如：

```bash
pnpm --filter @h5cs/database test
pnpm --filter ./apps/merchant-web dev
```

## 7. 停止与安全重置

普通停止会保留命名数据卷：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml down
```

只有确认本地开发数据可以永久删除时才执行重置。先停止容器并核对**精确卷名**：

```bash
docker compose --env-file .env -f infra/compose/docker-compose.dev.yml down
docker volume inspect h5cs_mysql_dev_data h5cs_redis_dev_data
```

输出必须指向本项目的本地开发卷。确认后删除这两个明确命名的卷，不要使用通配符、`docker system prune` 或跨项目批量删除：

```bash
docker volume rm h5cs_mysql_dev_data h5cs_redis_dev_data
```

随后重新执行第 3 节启动命令和第 5 节迁移命令。重置会永久删除本地 MySQL 数据；Redis 数据本来就不是业务真值。

## 8. 多阶段应用镜像

`infra/docker/workspace.Dockerfile` 使用 Node 24、pnpm 11 和 `pnpm deploy` 生成单应用运行目录。最终镜像以 Node 自带的非 root `node` 用户运行，不复制 `.env`，也不接受 Secret 类型的 build argument。

```bash
docker build -f infra/docker/workspace.Dockerfile --target api \
  --build-arg APP_KIND=api --build-arg APP_NAME=api -t h5cs-api:dev .

docker build -f infra/docker/workspace.Dockerfile --target worker \
  --build-arg APP_KIND=worker --build-arg APP_NAME=worker -t h5cs-worker:dev .

docker build -f infra/docker/workspace.Dockerfile --target web \
  --build-arg APP_KIND=web --build-arg APP_NAME=merchant-web -t h5cs-merchant-web:dev .

docker build -f infra/docker/workspace.Dockerfile --target web \
  --build-arg APP_KIND=web --build-arg APP_NAME=consumer-h5 -t h5cs-consumer-h5:dev .

docker build -f infra/docker/workspace.Dockerfile --target web \
  --build-arg APP_KIND=web --build-arg APP_NAME=ops-web -t h5cs-ops-web:dev .
```

健康检查约定：

- API 镜像调用 `/livez`，只验证进程存活；流量接入仍需独立检查 `/readyz`。
- Worker 镜像通过内部 `3011/livez` 验证进程存活；流量/任务调度门禁使用 `/readyz`，平台还必须监控 Job heartbeat 和最老 Job。
- Web 镜像默认探测 `/`；应用提供稳定健康路由后，通过 `HEALTHCHECK_PATH` 覆盖。

运行镜像时通过编排器的 Secret、只读挂载或运行时环境注入 server-only 配置。`NEXT_PUBLIC_*` 会进入浏览器构建产物，本来就不是秘密；任何 Token、数据库口令、Cookie/HMAC 密钥或模型密钥都不能使用该前缀，也不能作为 Docker build argument 烘入镜像。

## 9. 提交前检查

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
docker compose --env-file .env.example -f infra/compose/docker-compose.dev.yml config --quiet
```

CI 使用同一组 pnpm 命令，并额外执行常见 Secret 模式扫描和生产依赖高危审计。生产部署、云资源创建、数据库账号创建与安全组修改均不属于本地开发流程。
