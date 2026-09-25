# 管理 Web 路径构建变体

本说明只描述仓库已验证的可选构建方式，不是正式域名路由决策、镜像发布或生产切流授权。Next.js `basePath` 在构建时进入客户端资源；修改服务器环境变量或 Nginx 规则不能把已构建的根路径镜像变成子路径镜像。不同路径变体必须分别构建、生成不可变 digest，并在同一变体上完成验收。

| 用法                         | 商家 Web 构建参数                         | 运营 Web 构建参数                | 链接与探针配置                                                                                        |
| ---------------------------- | ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 独立主机根路径（当前默认）   | `NEXT_PUBLIC_MERCHANT_BASE_PATH=`         | `NEXT_PUBLIC_OPS_BASE_PATH=`     | `MANAGEMENT_CONSOLE_URL=https://<商家主机>/`；运营 `HEALTHCHECK_PATH=/login`                          |
| 同一域名分路径（待用户决定） | `NEXT_PUBLIC_MERCHANT_BASE_PATH=/console` | `NEXT_PUBLIC_OPS_BASE_PATH=/ops` | `MANAGEMENT_CONSOLE_URL=https://h5cs.1rying.com/console`；运营 `H5CS_OPS_HEALTHCHECK_PATH=/ops/login` |

`infra/docker/workspace.Dockerfile` 接收上述两个 build arg；仅允许表中的空值、`/console` 与 `/ops`，无效值使对应 Next.js 构建失败。运营后台和 WorkBuddy 生成管理链接时按 `MANAGEMENT_CONSOLE_URL` 保留 `/console`；商家客户端也只接受与自身构建前缀一致的可信管理链接。API 始终独立使用 `/api`，消费者 H5 的公开入口仍是 `/a`；本文件不改变它们。

反向代理必须将原始 `/console/...`、`/ops/...` 路径完整转发给对应 Web 容器，不能剥掉前缀。仅将 `/console` 代理到根路径 Next.js 镜像，或把 `/console` 镜像部署到根路径，都会导致页面、静态资源、Server Actions 或重定向失败。发布前用正式构建镜像与代理一起验证登录、领取、创建、发布、消费者固定链接、静态资源和 Server Actions；不要把本机路由冒烟当成此项验收。

CI 在默认构建之外，额外构建 `/console` 与 `/ops` 变体并验证对应页面、资源前缀及根路径隔离。候选镜像工作流当前仍按默认根路径构建；若最终选择同域名分路径，必须先把正式镜像工作流的 build args 固定为该方案、重新生成五个 digest，再进行同 digest 的 Staging/生产验证。不得拿默认镜像直接配置同域名路径路由。
