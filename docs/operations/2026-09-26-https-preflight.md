# 2026-09-26 HTTPS 只读预检

> 快照时间：2026-09-26 00:53 CST。此记录不授权证书申请、软件安装或切换生产 Nginx；发布前须重新核验实时状态。

| 检查项       | 结果                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS          | `h5cs.1rying.com` 的 IPv4 A 记录为 `114.132.92.111`；当时未查询到该主机名或 `1rying.com` 的 CAA 记录。                                                                       |
| 公网 HTTP    | 不经过工作站 HTTP 代理访问 `/gateway-health` 返回 200，实际远端为 `114.132.92.111`；请求不存在的 `/.well-known/acme-challenge/` 路径返回 404。                               |
| 主机         | 使用项目独立 SSH 身份、独立 `known_hosts` 和严格主机密钥校验登录；`SSH_CONNECTION` 已核对实际来源，未把动态出口 IP 记录到仓库。Nginx `-t` 通过，项目站点仍是唯一已启用站点。 |
| ACME webroot | `/var/www/letsencrypt/.well-known/acme-challenge` 已存在。404 仅证明占位路径可达；不能代替真实 ACME 验证。                                                                   |
| 证书工具     | Certbot 未安装；Ubuntu 22.04 软件源显示候选版本 `1.21.0-1build1`。                                                                                                           |
| HTTPS        | `/etc/letsencrypt/live/h5cs.1rying.com` 不存在，TCP 443 未监听。                                                                                                             |

下一步须由负责人确认接收续期通知的邮箱和申请正式证书的授权。获批后再选择受维护的 Certbot 安装路径，使用现有 ACME webroot 申请证书，并验证证书链、自动续期、HTTP→HTTPS、Nginx 语法与回滚；在此之前保持 HTTP 维护配置，不启用自签名生产入口。

## 2026-09-26 后续执行记录

负责人已确认接受 Let's Encrypt 订户协议并授权申请证书；离机备份暂缓。服务器通过 Snap 安装 Certbot 5.8.0，使用现有 `/var/www/letsencrypt` webroot 对 `h5cs.1rying.com` 完成正式签发。证书位于服务器的 `/etc/letsencrypt/live/h5cs.1rying.com/`（私钥不得复制到仓库）；证书主体和 SAN 均为该域名，签发者为 Let's Encrypt YE1，到期时间为 2026-12-25 13:59:47 UTC。

预演签发与正式签发成功，`certbot renew --dry-run` 也成功。首次正式申请时部分 CA 验证节点已取得 HTTP 200，但二次验证节点连接超时；检查确认公网 HTTP、Nginx 监听和 UFW 正常后，单次重试成功。`snap.certbot.renew.timer` 已启用并运行。

本次仅申请证书，尚未将证书绑定到 Nginx，也未启用 TCP 443 监听或 HTTP→HTTPS 跳转。此处原先要求续期通知邮箱的说法已过时：Let's Encrypt 已停止发送证书到期提醒邮件。上线 HTTPS 前仍需配置 Nginx、续期后重载及有效期监控，并验证公网 TLS；离机备份暂缓不代表已具备异机恢复能力。

## 2026-09-27 HTTPS 维护入口上线

已将正式证书绑定至生产 Nginx，并安装 Certbot 续期部署钩子，在证书更新后先运行 `nginx -t` 再重载。切换前配置备份为服务器上的 `/etc/nginx/sites-available/h5-ai-customer-service.pre-https.vclHSF`。对应受版本控制的配置与钩子位于 `infra/nginx/h5cs-https-maintenance.conf` 和 `infra/nginx/certbot-renew-reload-nginx.sh`。

公网无代理检查：`https://h5cs.1rying.com/gateway-health` 返回 200、TLS 校验通过；`http://h5cs.1rying.com/gateway-health` 返回 308，目标为 HTTPS；`https://h5cs.1rying.com/ops/` 返回 503，表明业务应用仍未部署。Nginx 语法通过且服务运行，80/443 均已监听。HTTPS 可用不等于平台后台、商家后台或消费者 H5 可用；模型凭据和完整业务发布仍待完成。

随后以 `certbot renew --dry-run --run-deploy-hooks` 演练，Certbot 日志确认模拟续期成功，部署钩子中的 Nginx 语法检查通过，Nginx 保持 active。该命令因 Certbot 非交互随机等待约六分钟；这是演练耗时，不是证书验证失败。仍需补充独立的证书到期监控与告警。
