# 商家资料与账号增强候选镜像离线交付

更新：2026 年 10 月 20 日。为保持既有工具引用，本文与计划保留历史文件名；本文的来源、摘要与运行编号均属于本轮新候选，不复用 R1 的验收结果。

本轮应用固定为 `07b6ae07052e4ed2f4200b23f3492cd10255ff26`，包含已合并的运营后台改版、文件材料知识库及账号重置功能。工具分支 `codex/offline-materials-delivery` 只改变运输工具和证据绑定，不重建应用、不执行服务器操作，也不把用户的发布授权描述成运输任务本身已经上线。

## 凭据和任务边界

工作站已有 GitHub 登录可读取仓库与 Actions 附件，但私有 GHCR 的实际读取返回 403。本工具在 GitHub 临时 Linux runner 使用 `GITHUB_TOKEN` 的 `contents:read`、`actions:read`、`packages:read` 读取本项目既有五镜像；服务器不需要新的长期 GitHub 令牌。

Token 不进入交付包或 Docker 子进程环境。附件只有镜像归档和非敏感身份清单，不包含运行环境、模型密钥、数据库或业务资料。不新建云资源；Actions 运行与附件仍受账户现有额度及计费规则约束。

## 固定来源

固定计划为 `scripts/operations/r1-offline-delivery-plan.json`，不允许 CLI 覆盖：

- [主分支 CI 39420040961](https://github.com/dingyong221/H5AICustomerService/actions/runs/39420040961)，attempt 1，精确提交 `07b6ae07052e4ed2f4200b23f3492cd10255ff26`，四项任务通过。
- [五镜像候选 39420409270](https://github.com/dingyong221/H5AICustomerService/actions/runs/39420409270)，attempt 1，同一提交，包含拉取精确五摘要后的浏览器闭环。
- 摘要附件 ID `12263204445`，ZIP SHA256 为 `cc34b30042cbe67517757495cdeb1e7ce32e5117bb1ada2fec7d6ba76fb27029`。
- 原始 `candidate-images.txt` SHA256 为 `e506bef685f958da763cc8621aee89c983451946566c6ccd92121b998f9ee16c`。
- Web 模式为 `same_domain`，管理资源路径保持商家 `/console`、运营 `/ops`；精确五摘要保存在计划中，不使用 `latest`。

导出器重新核验两个源运行的仓库、提交、attempt、工作流路径、成功状态，完整八项候选任务，以及附件元数据和下载后的文本哈希。发现应用、锁文件、数据库或其他非运输路径变化即停止。

## 执行与往返验证

仅在 `codex/offline-materials-delivery` 手动触发现有 `ci.yml` 执行运输任务。普通 PR、main 和其他分支仍执行原四项完整 CI；仅这个专用分支的手动运输运行跳过重复构建。运输任务先验证路径白名单、frozen-lockfile、静态发布策略、六文件格式与离线契约测试，再导出已验证的应用镜像。

导出器只接受 GitHub 托管 Linux runner、专用分支和默认本机 Docker socket。逐一拉取 `linux/amd64` 精确摘要，核对原 RepoDigest、配置 ID、非 root 用户及 OCI 来源、提交和路径模式。先保存临时 runner 原有镜像 ID；目标引用已经存在、配置预存或被容器使用均停止。

镜像使用专用 `h5cs-offline-{app}:{sourceSha}` 标签，以一次 `docker image save` 共享层去重导出，再 gzip 压缩。当前硬上限仍为解压 tar 2 GiB、压缩包 1 GiB；原生文档解析依赖可能增大本轮实际包，未运行本轮导出前不保证足够，不能把旧版大小当作本轮大小。tar 和 gzip 均边流式写入边限额，超限即停止，不清理业务服务器。

临时 runner 的额外容量门槛为 tar 上限、gzip 上限、2 GiB 保留空间及 64 MiB 元数据余量。已经拉取的镜像占用由当前可用空间体现，不将虚拟镜像大小重复计入。目标服务器容量必须根据本轮实际归档、导入新增层及运行／回退余量另行确认；本计划不是服务器容量证明。

归档完成后只移除本次五标签及其原摘要引用，不 force、不 prune；确认这些配置 ID 已消失后，真实 `docker image load` 往返，逐项复核配置 ID、平台、用户、来源和专用标签。失败不上传交付包。

成功后立即执行一次重复导出负例：必须在拉取、导出或移除前以 `PREEXISTING_IMAGE_REFERENCE` 拒绝，并核对镜像集合和五项身份完全不变。这不是正常恢复方式，也不允许覆盖预存镜像。

Docker `save` 保存选中镜像及层，`load` 可导入 gzip 并恢复标签，但不保证原 Registry RepoDigest 保留。[Docker 导出文档](https://docs.docker.com/reference/cli/docker/image/save/)、[导入文档](https://docs.docker.com/reference/cli/docker/image/load/)。`delivery.json` 将原 Registry 摘要、配置 ID、压缩包 SHA256、工具提交和运行编号绑定，并明确 `registryDigestsRetained:false`。

附件仅保留一天，内容为 `candidate-images.tar.gz` 和 `delivery.json`，上传不再次压缩 gzip。它不是业务备份、正式签名证明或已部署证明。

## 工作站及服务器停点

1. 下载本轮成功运输运行附件，核对精确工具提交和运行编号、GitHub 附件 ZIP 哈希及内部归档哈希。应用来源必须仍为 `07b6ae07052e4ed2f4200b23f3492cd10255ff26`，五项摘要及 `same_domain` 一致。
2. 先只读核对目标架构、Docker、磁盘、内存及本项目网络，再经项目专用 SSH 传输。不读取其他项目身份，不向服务器转发 GitHub Token。
3. 容量足以保留当前运行与回退余量后才导入；专用标签已存在时先核对身份，不覆盖未知镜像。导入只改变镜像库，不启动容器或写数据库。
4. 加载后核对真实归档／OCI 图、配置 ID 与当前 Docker 返回的运行镜像 ID，不能混淆 OCI manifest digest、配置摘要和 RepoDigest。使用既有项目身份验证流程，不伪造 RepoDigests。
5. 发布执行者另行进行维护、Worker 排空、配置比较、原生 PDF 解析、合成商家上传到消费者闭环、仅合成账号的重置和回退核验。商家容器需 1024 MiB／128 pids／0.6 CPU，网关上传限额 21m；模型和预览令牌仍沿用服务器受限挂载。本轮无需数据库迁移。

导入成功不代表服务上线。商家、Worker 与运营端需要协调更新；回退代码不撤销已成功的密码重置或删除已保存材料。目标服务器操作仍按当次明确发布授权及现场证据执行，不能自动安装组件、全局清理或回滚数据库。

## 验证口径

本地运行 `node --test scripts/quality/candidate-offline-contract.test.mjs`。真实 Docker 导出、移除、导入及预存镜像保护以本轮新 CI 任务结果为准，不以离线辅助测试替代。

`realModelVerified`、`provenanceAttestationVerified`、`publicDeployment` 固定为 false。源候选浏览器使用模拟模型，运输不调用千问；真实提供方和回答质量需在受控合成业务验收时独立核验。五镜像摘要和归档校验不能冒称签名或 provenance 已核实。
