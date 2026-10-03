# 2026 年 10 月 3 日 Web 发布现场盘点

本记录用于把仓库、候选镜像、Staging 和公网入口对齐，避免把“镜像存在”误认为“业务已上线”。以下均为当日只读核验结果；后续发布前须重新核对。没有对生产库执行迁移、没有改动 Nginx，也没有停止任何容器。

## 源码和候选构建

远端 `main` 为 `50d77669bf0a6626596383062312affa26f3156f`（PR #7 合并提交），不是传阅资料中提到的 `1cf11c9`。这个提交包含 Next.js `16.3.8` 修复，但尚不能定为最终发布提交：[候选工作流 37101504689](https://github.com/dingyong221/H5AICustomerService/actions/runs/37101504689)在 `braces@3.0.3` 新增高危公告的全量依赖审计处失败，五镜像任务被跳过。**没有这次合并提交的新五镜像 digest。**修复或明确批准独立的审计例外后，才冻结最终提交并只发布一套新制品。

## 服务器现有镜像

服务器上当前 Staging 运行的五个镜像都标注源提交 `70ffb0503c17eb440dacccf1745444e352d52db4`、路由模式 `same_domain`。以下是容器实际引用的完整摘要，不是 `50d7766` 的新制品。

| 部署单元 | Staging `70ffb05` 镜像摘要 | 保留的 previous `de74b248` 镜像摘要 |
| --- | --- | --- |
| API | `sha256:ae130e5207a1d471a2846e587b7c474f59ee88d97d76ad30f1781cf9c3ba2a74` | `sha256:8db78dfb711f0580a44651e4c8df25003c63935628f4c40a407bb2fe15cea694` |
| Worker | `sha256:3165253f9dea7c7a26b4803250a96d75786665ee01343edcba22e12e213c2825` | `sha256:340f14e39ab31a34f9b38fac37f69e70cdc7a5f03a46ce0ec3337f5f0bc11c42` |
| Ops Web | `sha256:44c96e4700e48ac66ed133dede434dda51aefde9a0fbe14bb78f76d90eca386d` | `sha256:3419b9c8bada4d3cc8726571214dbb148ff85062be46f1cf3707a29f0441fe4c` |
| Merchant Web | `sha256:a14f53064cdd5f35ea0400503adb2c90236e1c76dfbd925c764dcabc45a8fdf1` | `sha256:39bb2bb16783b142e5cc58b006e452df736b52783f6fab1138c1ecbb00028939` |
| Consumer H5 | `sha256:16cd09491ff76bd68277319e29beee829b948fb842a760cee01c7637dead6fe7` | `sha256:04253b5ab5c008c6338ca7cc9e448d40cb9b7dfaf501ef0a49d9aa1e80667d52` |

`previous` 五镜像在本机仍可检查到，并非生产数据库回滚保证；升级后的 Schema 兼容性仍须验证。服务器共有 20 个运行容器，包含 Staging、三套较早候选和生产 MySQL。根分区 50 GiB，已用约 22 GiB；盘点时系统报告 7.4 GiB 内存、约 4.2 GiB 可用。**清理旧候选栈仅是建议，不是本记录授权的操作**；必须先确定唯一回滚目标并取得停止/删除授权。

## 数据、模型和公网入口

- 生产 MySQL 容器健康，数据库 `h5_ai_customer_service_prod` 的业务表数量为 **0**；首次迁移尚未执行。宿主机未监听 3306。现有生产 SQL 压缩备份位于本机 `/var/backups/h5-ai-customer-service/mysql/`，文件约 600 字节，反映空库状态；Staging 另有同机备份。只读盘点未发现项目离机备份目标或定时任务的证据，**不能据此证明不存在其他外部备份，也不能称现有备份为离机灾备**。
- 受限的正式模型密钥文件存在，权限为 `0640`、数字 GID 为 `1000`，父目录为 `0700`；Worker 镜像运行身份为 `node`。Worker 配置中 `MODEL_PROVIDER=chat_completions`、`MODEL_NAME=qwen-plus`、接口地址已填写，但 `CONVERSATION_WORKER_ENABLED=false`，`MODEL_API_KEY` 和 `MODEL_API_KEY_FILE` 均为空。后者按[密钥文件接入方案](model-secret-file.md)应由发布时的 Compose 覆盖层设置，不应把空字段单独判为缺少密钥；目前**尚无正式 Worker 容器及挂载、真实模型调用验收**。Staging 的测试模型容器仍运行。密钥内容未被读取或记录。
- `https://h5cs.1rying.com/gateway-health` 返回 200；`/ops/`、`/console/`、`/a/`、`/api/` 均返回 503。`/mcp` 和 `/oauth` 也返回 503，虽然没有对外启用 WorkBuddy，但尚未达到 Runbook 规定的明确 404。Nginx 配置语法通过，HTTPS 对外可达；公开业务切流尚未执行。

## 下一次发布必须先完成

1. 处理新高危依赖审计阻碍，冻结一个最终源提交，并且只为该提交生成一套五镜像不可变摘要及签名/来源证据；不得复用上述旧镜像切流。
2. 将精确新摘要更新到 Staging，复验运营开通、商家认领与发布、消费者真实千问回复、租户隔离、异步任务、SSE、审计、TLS 路由以及应用回滚。
3. 明确离机备份目的地，或由项目负责人书面接受**仅限受控试运行**的单机数据损失风险；完成正式 Worker 密钥挂载、容量/人工巡检、变更单和回退清单。
4. 首次生产数据库迁移与公网业务切流是两项独立高影响操作，分别取得执行当时的明确授权；在此之前保持生产库不迁移、公网业务路径 503。
