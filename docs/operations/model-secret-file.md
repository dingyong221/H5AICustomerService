# 对话模型密钥文件接入

此能力只提供安全的文件读取与容器挂载方式，不代表已经取得正式模型凭据或批准生产对话流量。未配置真实模型时，Worker 继续保持不可用，不得以 Mock 回退。

1. 在已批准的 Secret 管理流程中，将密钥投递到服务器专用目录下的独立文件；不要写入仓库、Compose 环境文件、命令参数或聊天记录。宿主目录应为 `root:root`、`0700`；文件可用 `root:1000`、`0640`，使容器内非 root 的 `node` 用户（UID/GID 1000）只读访问。部署前核对实际容器身份与挂载权限，不要为修复权限改成全员可读。
2. Worker 环境文件填写已批准的 HTTPS Chat Completions 端点、模型名和 `MODEL_PROVIDER=chat_completions`，保持 `MODEL_API_KEY` 为空。将 `H5CS_MODEL_API_KEY_HOST_FILE` 指向上述宿主文件，并在正式发布的 Compose 命令中附加 `infra/compose/docker-compose.release.model-secret.yml`；该覆盖层把文件只读挂到 `/run/secrets/h5cs-model-api-key` 并设置 `MODEL_API_KEY_FILE`。
3. 同时设置 `MODEL_API_KEY` 与 `MODEL_API_KEY_FILE`、使用相对路径、缺失或格式无效的文件，都会使 Worker 拒绝启用对话。密钥不会出现在配置对象的 JSON 序列化结果中。不要通过 `docker inspect`、`env` 或日志输出密钥内容。
4. 发布前用真实供应商完成脱敏冒烟、超时/拒绝/限额验证以及轮换与撤销演练。只有健康检查和端到端咨询均通过，才可将模型门禁标记完成。

本文件不替代 Secret Manager、审批、轮换记录或生产发布 Runbook。

## 商家发布前试聊

试聊使用 Worker 中已有的千问密钥。商家 Web 只持有独立的内部调用令牌，不持有模型密钥。试聊读取已保存的当前草稿，验证商家登录、CSRF 和草稿版本；不会建立消费者会话或发布客服。界面提示商家仅输入测试资料，草稿资料、价格/优惠说明和测试问题将发送至阿里云千问。

在服务器项目专用 Secret 目录生成 32 字节随机、base64url 编码的令牌（43 字符），存为 `preview-auth-token`，权限沿用上述 `root:1000`、`0640`。令牌不得打印或写入仓库。将 `H5CS_PREVIEW_AUTH_TOKEN_HOST_FILE` 指向该文件，并附加 `infra/compose/docker-compose.release.preview-auth.yml`；它只读挂载同一令牌至 Worker 和商家 Web 的 `/run/secrets/h5cs-preview-token`。生产环境禁止用明文环境变量 `PREVIEW_AUTH_TOKEN` 替代文件。

Worker 内部端点不经过公网 Nginx；未携带令牌的请求返回 404。每个商家每分钟最多试聊 5 次，问题最长 500 字；当前限流为单 Worker 进程内限流。预发布环境及正式受控试运行必须使用独立令牌。
