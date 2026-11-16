材料解析隔离是显式发布配置。将 `docker-compose.release.material-parser.yml` 放在 release/MySQL 覆盖文件之后；与原 Web 使用同一个已审阅镜像 digest。增加独立 512MiB、0.4 CPU、48 PID 和 64MiB tmpfs 的 parser 服务，需先评估目标机资源；本文件不表示已部署或已验证容量。

唯一共享挂载是 `material-parser-socket` 命名卷，固定目录由新镜像创建为 UID/GID 1000、0700，socket 为 0600。Web 只读挂卷但可以连接 Unix socket；parser 可创建/清理自己 UID 的 stale socket，拒绝 symlink、普通文件和正在监听的 socket。不要绑定已有主机目录，不要添加 Docker socket、env_file、secrets、DB/模型/会话挂载或网络。parser 根文件系统只读，使用原 Office 防护与 PDFium 预热目录。

`H5CS_MATERIAL_PARSER_MODE` 默认 `local`（原本地/CI行为），只有 `isolated` 才访问固定 socket；未知值、服务中断、畸形响应一律失败。隔离启用后没有本地回退。健康只控制启动顺序；运行中故障会使材料提取失败，Web 继续运行。需要回滚时必须显式审阅配置切换，不自动绕过隔离。

HTTP 上传仍在原请求中执行：进程级最多两批、无队列、每批最多5文件/20MiB，单文件10MiB，30秒共同上传和提取预算，每文件最多20秒。单 broker 最多一个原生解析。扩容 Web 之前需另评估总上传缓冲；这个进程级准入不是跨副本分布式配额。清理环境的原子进程不是独立OS隔离，只有实际容器运行才能验证该边界。

Request.signal/预算中断停止读流、杀当前解析并停止后续文件，保存前再检查。已发给 MySQL 的保存仍等待原repo收据，可能已经提交；用户应刷新核对，内容SHA256继续原幂等去重。原文件没有持久blob/任务，因此不宣称重启后自动恢复或整批原子回滚。

独立 CI 入口 `.github/workflows/material-parser.yml` 与 `scripts/quality/verify-material-parser-isolation.mjs` 只运行一次性合成环境；不使用真实凭据、不接生产。将来由A0单独接主CI，真实Linux Docker证据到齐、A7独审后才可标记OS隔离已验证。
