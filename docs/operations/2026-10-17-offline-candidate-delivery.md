# R1 私有候选镜像离线交付

状态：交付工具准备，不是生产迁移或切流授权。应用继续固定为 `a3edb4274480207cbb541b016cae87dd12169a56`；工具分支 `codex/offline-candidate-delivery` 不修改这五个应用镜像，也不替代真实千问预发布验收。

## 使用原因和凭据边界

工作站已有 GitHub 登录可以读取私有仓库与 Actions 附件，但访问私有 GHCR 的实际读取返回 403。离线交付使用已有 GitHub 登录下载附件，由项目专用 SSH 传输镜像包；服务器不接收新的长期 GitHub 令牌。它沿用既有 Actions 构建与附件机制，不新建云主机、云盘或其他云服务，仍受账户现有额度与计费规则约束。

只在 GitHub 临时 Linux runner 使用限权 `GITHUB_TOKEN` 读取本项目的既有镜像和 Actions 证据。Token 不写入交付包、不传给 Docker 子进程环境、不传到服务器。包只包含 Docker 镜像归档和非敏感身份清单，不包含模型密钥、运行环境文件或数据库。

## 固定的应用来源

计划文件为 `scripts/operations/r1-offline-delivery-plan.json`，锁定以下来源，不接受 CLI 覆盖：

- [应用统一 CI 38957600094](https://github.com/dingyong221/H5AICustomerService/actions/runs/38957600094)，首次运行，head 为 `a3edb42`，四个任务通过。
- [候选镜像 38958679037](https://github.com/dingyong221/H5AICustomerService/actions/runs/38958679037)，首次运行，八个任务通过，包括使用精确摘要拉取后的浏览器闭环。
- 摘要附件 ID `12071593142`，ZIP SHA256 为 `6239ac3ad9d85fa0f47976339fde1c24f4097070ea5e163a43cc61e38252de8e`。
- 原始 `candidate-images.txt` SHA256 为 `fa2569298fe9f87ec9148e5940f1c921aecf6a4b0add63ebf63bf90b3afceaeb`；模式为 `same_domain`，商家资源路径 `/console`、运营路径 `/ops`。

精确五镜像摘要保存在计划中；不以可变化的 `latest` 标签选择应用版本。导出器重新读取两个源流水线的状态、仓库、SHA、attempt、工作流路径和完整候选任务集合，并核对摘要附件元数据及下载后的文本哈希。

工具提交只允许改变 CI、离线契约／测试／导出器、固定计划和本文。发现应用、锁文件、数据库或其他源码变化就停止，不把工具分支混成另一个业务版本。

## 导出和往返核验

在专用工具分支手动触发现有 `ci.yml`。原有四个 CI 任务不删除、不降级；新增导出任务等待质量检查通过后运行，权限只有 `contents:read`、`actions:read`、`packages:read`。

导出器只允许 GitHub 托管 Linux runner、专用分支和默认本机 Docker socket。逐个拉取计划中的 `linux/amd64` 精确摘要，核对原 RepoDigest、镜像配置 ID、非 root 用户和 OCI 来源／修订／路径标签。保留临时 runner 原有镜像 ID 清单；任何目标已经存在或被容器使用都停止，不删除预存镜像。

为本次五镜像建立 `h5cs-offline-{app}:{sourceSha}` 专用标签，通过 `docker image save` 导出一个共享层去重归档，gzip 压缩后记录大小和 SHA256。解压归档上限 2 GiB，压缩后上限 512 MiB；先检查临时 runner 容量。tar 的输出流在写入时计数，超限即停止本次导出子进程。生成目录仅在 runner 临时目录下，不操作业务服务器或工作区数据。

容量按新增的 tar 上限、gzip 上限、2 GiB 保留空间及 64 MiB 元数据余量计算；拉取镜像已经占用的空间由当前磁盘余量体现，不再把重复计算共享层的虚拟镜像总量当作归档大小。首次工具运行在旧容量预检处停止，未生成交付附件；后续运行须实际证明有界导出和加载成功，不能把预估修正当作验收完成。

归档完成后，仅移除本次建立的五个标签与原摘要引用，不使用 force 或 prune。确认五个配置 ID 确实已不在本机镜像库，再由 `docker image load` 导入压缩包，逐个核对加载后的配置 ID、平台、用户、来源标签及专用标签。失败不上传交付包。

首次往返成功后，CI 再调用一次相同导出器。由于五个专用标签已经存在，第二次必须在拉取、导出或删除前以 `PREEXISTING_IMAGE_REFERENCE` 停止；检查镜像 ID 集合及五项身份保持不变。该负例验证的是预存镜像保护，不把重复导出当作正常恢复方式。

Docker 官方说明 `save` 保存选定镜像、标签和父层，`load` 可导入 gzip 包并恢复镜像及标签。[导出文档](https://docs.docker.com/reference/cli/docker/image/save/)、[导入文档](https://docs.docker.com/reference/cli/docker/image/load/)。加载后不假设原 Registry RepoDigest 一定保留；`delivery.json` 将原摘要、实际配置 ID和压缩包哈希关联，并明确标记 `registryDigestsRetained: false`。

成功附件仅保留一天，包含 `candidate-images.tar.gz` 和 `delivery.json`；上传不再次压缩 gzip 内容。附件仍是候选交付物，不是业务备份或正式签名证明。

## 工作站和服务器的执行停点

1. 从本项目成功的交付运行下载附件，核对实际工具提交、运行 ID、GitHub 附件 ZIP 哈希及归档 SHA256；检查来源应用仍为 `a3edb42`、精确五项及 `same_domain`。不从聊天粘贴 Token，不读取其他项目凭据。
2. 先只读核对目标架构、Docker、磁盘、内存及网络，再经本项目专用 SSH 传输。保留现有应用、回退镜像和数据卷，不为导入包清理旧栈。
3. 只有目标容量足以保留运行和回退余量时才导入。导入前检查专用标签是否已经存在；存在时先核对配置 ID，不覆盖未知镜像。导入不启动容器，也不改数据库。
4. 导入后逐个核对配置 ID、标签、平台及源码修订，才允许私有 staging 使用这些已核验的本地标签。保留源摘要、归档及配置 ID 的映射，不伪造 Docker RepoDigests。
5. 预发布仍使用独立数据库和队列、回环入口，验证升级、新旧客户端、失败恢复及真实千问闭环。生产高影响迁移、维护窗口和公网切换另行确认。

不自动安装宿主新组件；不调用 `docker load` 代替容量预检，不连接生产数据库测试，不因镜像包导入成功就宣称服务已上线。

## 验证口径

本机先运行 `node --test scripts/quality/candidate-offline-contract.test.mjs`，覆盖来源、五项集合、错误摘要／仓库／修订／标签／平台、路径白名单、不实质量标记及非专属上下文的拒绝。真实 Docker 导出、移除、导入和预存镜像保护必须由新增 CI 任务验证，离线辅助测试不能替代它。

`realModelVerified`、`provenanceAttestationVerified`、`publicDeployment` 均固定为 false。源候选浏览器使用固定测试模型；五个 GitHub provenance 步骤为 skipped。传输工具不改变这些事实，不得写成真实模型、签名或生产部署验收通过。
