# Changelog

## 0.1.0 - 2026-09-22

首个仓库标准版本。该版本建立可审计、失败关闭的产品基础，不代表生产业务已上线。

### Added

- WorkBuddy 双入口、OAuth 2.1/MCP、平台登录会话、身份绑定、商家选择与 consent 的安全契约和 MySQL 事实仓储。
- 客服 onboarding、草稿生成事实、乐观版本编辑、不可变 Release、活动版本切换与公开快照仓储。
- Merchant Web 的可信授权与客服管理客户端，以及 Consumer H5 的公开客服、会话、消息和轮询客户端。
- Node 24 发布门禁、固定 SHA 的 CI Actions、CycloneDX SBOM、源码哈希、证据验证、不可变镜像 Compose 和回滚 Runbook。
- 腾讯云生产候选机的独立 SSH/安全组、Ubuntu/Docker/Nginx 基线与域名 HTTP 维护入口。

### Security

- 运行时缺少真实 WorkBuddy、签名器、数据库或生成器时直接拒绝，不使用测试身份、假链接或假成功。
- OAuth 回调参数在网络请求前从浏览器地址清除；管理写操作要求同源 Cookie、CSRF、幂等键与 ETag。
- 公网仅预留 80/443；SSH 仅允许工作站实时出口 `/32`；MySQL 和应用内部端口不开放公网。

### Not production-ready

- 管理/Public API 与消费者 Session/Message 服务端主链尚未贯通。
- 真实 WorkBuddy、托管私网 MySQL、正式模型、TLS、镜像仓库、Staging、监控告警和回滚演练尚未完成。
