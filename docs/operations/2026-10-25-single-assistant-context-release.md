# 唯一客服与消费者上下文发布记录

更新时间：2026-10-25（Asia/Shanghai）。已完成发布，开闸时间2026-10-25 18:58:21（Asia/Shanghai），业务源码89beba52a3152af54e322d6fab6402bff6f0e452。下方“待完成”属过程记录，实际终态见末节。

## 业务版本及验证

- PR [#22](https://github.com/dingyong221/H5AICustomerService/pull/22) 已合并，业务源码 `89beba52a3152af54e322d6fab6402bff6f0e452`，树 `e3fce21ff855ebe8d34f99d1d169c3e720c45ff8`。本地工作树 `codex/one-assistant-context` 的 `238b6cf` 与合并提交业务树相同。
- [主线 CI](https://github.com/dingyong221/H5AICustomerService/actions/runs/40182086836) 四项成功；[同域五镜像候选](https://github.com/dingyong221/H5AICustomerService/actions/runs/40182089583) 八项成功，包括五镜像启动、真实 MySQL 和镜像浏览器流程。
- 本地真实 MySQL 新增4项/原治理8项/API25项、桌面和手机模拟各14阶段、34表独立恢复通过，细节见 `../development/single-assistant-context-2026-10-25.md`。Windows 全仓 lint/typecheck/unit/format 已通过，远程 Linux 检查也成功。
- 首轮 PR CI 的浏览器失败是旧菜单定位测试漏提交，已由 `238b6cf` 补齐后完整复验。失败原日志保留，不覆盖为成功。

## 制品交付

- 当前 GCM 凭据能操作代码，但读取 GHCR 镜像 manifest 返回403；未要求新令牌，复用已验证的离线交付工具。
- 临时传输分支 `codex/offline-one-assistant-context`，提交 `da535e4e6336179131604c9dcd727ecc7f55f7c2`。仅修改契约允许的六个工具路径，不合并回业务主线；26项离线契约测试通过。
- [离线导出](https://github.com/dingyong221/H5AICustomerService/actions/runs/40183086663) 成功，验证同源码主线四项、候选八项，以及五镜像 save/remove/load 往返。
- 源摘要清单 artifact `12594184056`；完整离线 artifact `12594543569`，735247575字节，SHA256 `d7442cdc53383620170874231de7e13c6692ff8eb43a23bb4bce44558afb2f47`。图校验工具19项单元测试、发布控制器18项纯离线测试通过。
- 工作站下载较慢，部分文件保留在实现树 `artifacts/single-assistant-context-20261025/offline/`。改为通过专属加密SSH将短时、单artifact下载地址交给服务器内存；不传递工作站PAT，地址不落盘。服务器从原始 artifact 续传缺片，随后验证整个ZIP摘要/CRC、内层gzip摘要及完整镜像图，再精确导入五镜像。
- 首次服务器下载在275片已落盘后出现分片失败；只读确认尚未开始镜像导入，再凭分片摘要续传缺片。原失败日志保留。尚待完整归档及镜像导入收据，不能称制品已部署。

## 服务器准备与变更边界

- 服务器仍为 `114.132.92.111`，原业务版本979c9c2、14迁移。只读预检32业务表、无多份已发布客服歧义、正式域名入口200；SSH实际来源114.92.10.197。专用SSH隧道+本机CONNECT代理保留域名/SNI及正式TLS校验，TLS1.3通过，没有忽略证书错误或修改全局DNS。
- 按用户既有测试镜像清理授权，删除5个停止且断网、根文件系统只读的 `h5cs-quality-history-*` 旧验收容器及 aee4cc7 对应5镜像；不删除卷。其余容器、卷及Nginx回读一致，可用空间由3624710144增至6813421568字节。受限恢复配置仅存服务器root专属目录，不复制进聊天或仓库。
- 镜像导入准备根 `/opt/h5-ai-customer-service/changes/one-assistant-import-20261025`，临时RAM目录 `/dev/shm/h5cs-one-assistant-89beba5`。当前业务及当前979镜像保留。
- 发布根计划为 `/opt/h5-ai-customer-service/changes/one-assistant-context-20261025`。控制器按准备→维护→停写排空/备份恢复→14到15迁移→五服务更新→私有验证→开闸执行，阶段独占回执，失败/失联不自动重复。新版本仍使用原环境、网络、挂载和端口，仅换经图验证的确切镜像ID。
- 迁移前锁定旧表指纹，备份后在独占镜像恢复库验证，再调用候选镜像内已审计的 managed migration；校验15条完整历史、32旧表行/结构、唯一客服绑定及原固定链接。旧14迁移控制器不参与执行。
- 私有验收拟创建一套明确标为合成测试的商家/客服，最多请求7轮真实千问（含1轮试聊），验证A/B消费者、关标签续聊及主动新咨询；开闸后再从真实公网请求1轮。记录可见结果与请求预算，不把它当供应商精确账单或总体质量保证。

## 过程中的待完成清单（已由终态完成）

归档/完整图校验与镜像导入；服务器受限备份恢复及迁移；五服务更新；真实千问私有上下文验收；正式域名开闸及公网复验。每项成功后更新本节与HANDOFF。

证据总目录：`F:/WorkStation/CODEX/worktrees/materials-publish-integration/H5AICustomerService/artifacts/single-assistant-context-20261025/`。原图/源码/业务数据、失败日志及暂停记录保留；新增收费资源、支付、短信和WorkBuddy均不在本次范围。单机无离机备份仅限既有受控试运行，不晚于2026-11-03T15:59:59Z。

## 已部署终态与实际验收

- 开闸：2026-10-25T10:58:21.292156+00:00，Nginx恢复原始配置摘要；五个业务服务全部healthy，MySQL迁移15条、业务33表加tracker共34表。原17个客服地址及发布指针保持，13个原在线入口返回200、4个原未发布入口返回404，状态未改变。
- 当前17个商家→客服绑定，历史assistant原行保留；总18条历史客服记录包含1个已解除管理资格的旧未发布草稿。合成验收只新增1商家/1客服，没有合并历史资料或改变原链接。
- 停写排空后的同机备份：/var/backups/h5-ai-customer-service/mysql/h5cs-prod-20261025T104113Z.sql.gz，110409字节，SHA256 578349e7d7644a85cd0339e71ecd03d17d8a9887fdf9b228783a03e7c08bbb0e；原始SQL摘要aae2594f0ef63d71eb3cd154b4e83d092fe5b694f573e7433255996c145449da。在同机隔离schema h5cs_one_assistant_restore_20261025恢复后，32张旧业务表数据/结构摘要与源一致：28feda451b71ecb606240c6208035843ca2c70ec82115b5a55c75450636533e4。本地另有34表独立MySQL实例恢复证据，两种验证的范围分别保留。
- 14→15迁移后32旧业务表完整行/结构摘要保持，绑定回填16个已有商家。后续合成商家使绑定变为17；迁移前后全部原发布指针保持。
- 真实千问私有验收：已复核同修订价格99元/蓝白色；A选择3个蓝色，关标签后恢复仍为3蓝/99元；B初始没有选择记录，再选择2个白色；A仍为3蓝；A主动新咨询后没有旧选择记录。每个商家仅1个assistant和1个绑定的实际SQL检查通过。
- 第一轮验收脚本错误等待“发送按钮启用”（空输入时按钮正常禁用）而停止；只读确认对应对话完成后，修正为等待输入框启用，复用已发布合成客服及已验证试聊，重新建立独立消费者上下文。保留首轮完整证据，没有重复创建商家。最终私有记录含7条已审阅结果（含复用的1条试聊），另有首轮额外1条已完成对话；公网再验证1条“99元/个”。本轮共发起9次问答请求并观察9条结果，未核供应商逐请求账单，不称精确扣费次数。
- 公网复验：正式域名、TLS1.3、证书校验开启，真实回答“A水杯单价是99元/个”。最终队列/在途0/0，原指针保持、其他容器/卷保持，磁盘可用3603054592字节。一次性成功迁移容器已按精确ID清除；临时RAM归档已释放。
- 完整图验证先因旧工具残留上次run IDs/清单hash停止；v2校验器保留全部原严格条件，替换为本次已独立核验的固定输入，新增真实metadata回归后22项通过，再完整核验gzip、每个OCI blob、config/rootfs/manifest及实际加载ID。首轮失败和原校验器保留；没有在未证明身份时加载镜像。

关键证据：实现树artifacts/single-assistant-context-20261025/下final-production-verification.json、private-smoke-result.json、public-smoke-result.json、migrator-cleanup-completed.json、drain-backup.log、migrate.log、verify.log、open.log。服务器阶段收据位于发布根，导入收据位于导入根；均保留原失败记录。

## 使用及后续边界

商家刷新后台后使用“我的AI客服”，各菜单直接维护同一个客服；旧创建入口返回原客服。客户继续使用原固定链接；同一浏览器在30分钟无新提问的会话有效期内可续聊，主动新咨询重置上下文。没有新增跨设备消费者身份识别或永久记忆。

本轮需求已实现、验证并部署。真实手机/iOS/微信尚未专项验收；本轮手机是390px Chrome触屏模拟。AI超市A6、支付、WorkBuddy及更换模型不在本次范围。无离机备份仍仅限原受控试运行，原11月3日期限不延长。发布记录本地及远程归档分支codex/one-assistant-release-record，业务镜像及main源码保持89beba5。
