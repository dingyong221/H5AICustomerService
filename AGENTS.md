# H5 AI Customer Service 项目协作约束

## 生产服务器与安全组

- 当前候选生产服务器：腾讯云广州七区，实例 `ins-oo7je11q`，公网 `114.132.92.111`，内网 `10.8.11.111`。
- 项目专属安全组：`sg-g1zx69r5`（`h5-ai-customer-service-prod-sg`）。不得把其他项目的安全组、SSH私钥、主机指纹或固定脚本参数直接复用于本项目。
- 专用SSH身份文件为本机 `.ssh/h5_ai_customer_service_prod_114_132_92_111_ed25519`；不得读取、输出、上传或写入仓库其私钥内容。
- SSH只允许工作站当前公网出口的精确 IPv4 `/32`，不得为排障把TCP 22开放到 `0.0.0.0/0`。
- 工作站公网出口会变化。每次SSH连接超时或失败时，首先从当前工作站使用至少两个不经过HTTP代理的公网IP回显服务交叉核对实时出口，再只读查询 `sg-g1zx69r5` 的当前Version、完整规则和关联实例。
- 若实时出口的 `/32` 未出现在TCP 22允许规则中，优先向该专属组追加当前 `/32`，回读确认规则与版本后再重试SSH。默认保留旧来源规则以便回滚；删除或替换旧规则需用户另行明确授权。
- 网络规则确认后，使用独立 `known_hosts`、`StrictHostKeyChecking=yes` 和显式专用身份连接；只有端口可达后才继续排查SSH用户、密钥授权、`sshd`或主机防火墙。
- 成功登录后通过服务器的 `SSH_CONNECTION` 核对实际来源地址，不能仅凭公网回显认定最终来源。
- 当前公网业务入口规则为IPv4 TCP `80,443`；数据库、Redis、Docker API、应用内部端口和监控端口不得开放公网。
- 云端写入前必须读取最新规则、Version和完整关联；写后必须用API回读规则、关联数量和RequestId。响应不确定时只读核实，不盲目重试创建或覆盖。
- 服务器 ED25519 Host Key 已通过腾讯云 VNC 独立核对，指纹为 `SHA256:yQ+SCaFFTHzcaT3a3fTGFjQfB7/Z6ipYtNFYIOJgTJw`；本机固定使用 SSH 别名 `h5-ai-customer-service-prod` 和项目独立 `known_hosts`。
- 服务器基线已于 2026-09-21 完成：主机名 `h5-ai-customer-service-prod`、Ubuntu 22.04、内核 `5.15.0-191-generic`、UFW、Fail2ban、Docker/Compose、Nginx 和 2 GiB swap。基线脚本位于 `scripts/operations/`。
- 当前正式域名为 `h5cs.1rying.com`，A 记录已解析到 `114.132.92.111`。Nginx 仅为该 Host 在 TCP 80 提供 `/gateway-health`，其他路径返回 503；直接 IP 和未知 Host 被丢弃。TCP 443 只在云安全组和 UFW 预留，取得正式证书前不得启用无证书监听或自签名生产入口。
- Docker 容器业务端口必须绑定 `127.0.0.1` 或仅加入内部网络，再由 Nginx 代理；禁止通过 `0.0.0.0:<内部端口>` 绕过 UFW。`ubuntu` 不加入 `docker` 组，Docker 管理继续使用 `sudo`/systemd。
- 主业务事实存储已确定为 MySQL InnoDB，权威约束见 `docs/design/11-adr-mysql-storage.md`；此前 PostgreSQL/pgvector/RLS 专用设计已被取代。Redis与向量索引均不是业务真值。
- 生产优先使用托管私网 MySQL；当前 2 vCPU/8 GiB 应用/网关机不得自行安装生产 MySQL。TCP 3306 永不开放公网，创建云实例、账号、Secret 或费用资源须另行明确授权。
