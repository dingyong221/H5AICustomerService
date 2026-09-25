# 管理 Web 路径构建变体

本说明只描述仓库已验证的可选构建方式，不是正式域名路由决策、镜像发布或生产切流授权。Next.js `basePath` 在构建时进入客户端资源；修改服务器环境变量或 Nginx 规则不能把已构建的根路径镜像变成子路径镜像。不同路径变体必须分别构建、生成不可变 digest，并在同一变体上完成验收。

| 用法                         | 商家 Web 构建参数                         | 运营 Web 构建参数                | 链接与探针配置                                                                                                                                                      |
| ---------------------------- | ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立主机根路径（当前默认）   | `NEXT_PUBLIC_MERCHANT_BASE_PATH=`         | `NEXT_PUBLIC_OPS_BASE_PATH=`     | `MANAGEMENT_CONSOLE_URL=https://<商家主机>/`；商家 `H5CS_MERCHANT_HEALTHCHECK_PATH=/account/login`；运营 `H5CS_OPS_HEALTHCHECK_PATH=/login`                         |
| 同一域名分路径（待用户决定） | `NEXT_PUBLIC_MERCHANT_BASE_PATH=/console` | `NEXT_PUBLIC_OPS_BASE_PATH=/ops` | `MANAGEMENT_CONSOLE_URL=https://h5cs.1rying.com/console`；商家 `H5CS_MERCHANT_HEALTHCHECK_PATH=/console/account/login`；运营 `H5CS_OPS_HEALTHCHECK_PATH=/ops/login` |

`infra/docker/workspace.Dockerfile` 接收上述两个 build arg，并把相同路径保留在 Web 镜像的运行环境供 Next.js 读取；仅允许表中的空值、`/console` 与 `/ops`，无效值使对应 Next.js 构建失败。只在构建时传入 basePath 而在容器运行时丢失，会让已构建的分路径页面返回 404。运营后台和 WorkBuddy 生成管理链接时按 `MANAGEMENT_CONSOLE_URL` 保留 `/console`；商家客户端也只接受与自身构建前缀一致的可信管理链接。API 始终独立使用 `/api`，消费者 H5 的公开入口仍是 `/a`；本文件不改变它们。

反向代理必须将原始 `/console/...`、`/ops/...` 路径完整转发给对应 Web 容器，不能剥掉前缀。仅将 `/console` 代理到根路径 Next.js 镜像，或把 `/console` 镜像部署到根路径，都会导致页面、静态资源、Server Actions 或重定向失败。发布前用正式构建镜像与代理一起验证登录、领取、创建、发布、消费者固定链接、静态资源和 Server Actions；不要把本机路由冒烟当成此项验收。

同域名方案的[候选 Nginx 配置](../../infra/nginx/h5cs-single-domain.conf.example)把 `/ops/`、`/console/`、`/api/`、`/mcp`、`/oauth/` 和 OAuth 元数据路由到各自的 loopback 端口，其余公开页面由消费者 H5 提供；传给运营端的 `X-Real-IP` 由 Nginx 用真实 `$remote_addr` 覆盖。该文件只覆盖初始 Compose 端口，不会自动完成蓝绿切换。CI 用一次性自签证书检查语法，并在隔离高位端口用模拟后端检查路径转发、ACME、跳转和未知 Host 拒绝；自签证书不会进入镜像或生产，这些检查不等于正式证书、真实用户会话或服务器路由已验收。路由和 TLS 获批、正式镜像摘要确定后，仍须以受控变更在服务器上执行 `nginx -t`、回读有效配置、灰度验证和回滚准备，不能直接复制候选文件覆盖现有维护入口。

CI 在默认构建之外，额外构建 `/console` 与 `/ops` 变体，验证对应页面、资源前缀及根路径隔离，并在两个变体下分别运行运营开通、商家领取/生成/发布、消费者咨询的完整浏览器场景。该 CI 场景仍通过不同本机端口运行各 Web 服务，不证明正式同域名 Nginx、Cookie 和 WorkBuddy 回调。候选镜像工作流不再由标签推送隐式触发；经授权手动发布时须显式选择 `web_path_mode=root` 或 `same_domain`，`undecided` 会阻断镜像任务。五镜像的本地运行冒烟和正式推送使用相同构建路径，digest 清单同时记录路径模式；选定模式、健康检查路径、管理链接与 Nginx 必须一致，之后还须用同一 digest 完成 Staging/生产验收。不得拿根路径镜像直接配置同域名分路径路由。
