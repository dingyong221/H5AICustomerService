# 当前工作交接

更新时间：2026-10-26 02:03（Asia/Shanghai）。本轮商家菜单改名已实现、验证、部署，没有待发布动作；不要重放旧下载/切换/迁移。

## 当前状态

商家侧栏统一“AI客服管理”，不再有单独“创建客服”菜单；已有客服直接维护原客服，首次进入在管理页开通。工作台、返回链接、相关标题及帮助已同步。PR #23已合并main db1cce6cf108555f94b860543ae5ab3ee2992309；商家端镜像来自等价业务树580d5050541919078c9419eb57670b7c68388b7b。商家端361测试/lint/typecheck、PR四项CI和单镜像构建/运行往返成功；公网桌面/手机模拟菜单与原固定客服链接通过，本轮千问0次。详证和回退见docs/operations/2026-10-26-merchant-menu-release.md。

API/Worker/消费者H5/运营端保持89beba5；只有merchant-web更新，原数据、18条历史客服记录/发布指针/固定地址、15迁移、其他容器/环境/端口和Nginx保持。旧商家端镜像保留回退，临时RAM归档已释放。前版唯一客服/消费者上下文验收见docs/operations/2026-10-25-single-assistant-context-release.md。

## 关键规则与文件

每商家只有一个当前客服绑定，修改/知识/改善/发布都基于同一客服。消费者凭HttpOnly访客凭证独立上下文，同浏览器会话30分钟无新提问到期；主动新咨询重置，跨设备不自动关联。固定客服地址不随会话变化；1条历史未发布草稿保留原始行但不作为第二个可管理客服。

入口AGENTS→本文件→docs/README。需求docs/product/single-assistant-consumer-context-2026-10-25.md；实现docs/development/single-assistant-context-2026-10-25.md。实现R=F:\WorkStation\CODEX\worktrees\materials-publish-integration\H5AICustomerService，记录分支codex/merchant-menu-release-record，证据R/artifacts/menu-management-20261026/。主区仍旧codex/platform-provisioning、用户脏修改保留，不能据其旧源码判断线上状态。

## 约束及下一步

当前任务完成，后续按新需求推进。仍同域Web/MySQL/千问、专属SSH/正式TLS，不新增收费资源、支付、短信或WorkBuddy；无离机备份仅限受控试运行，不晚于11月3日。SSH已核实际来源114.92.10.197；连接失败先核出口及专属安全组。未验iOS/微信真机和总体语义质量。A6独立副本尚未合并，须追加到15迁移后并复用唯一绑定，仍待超市身份/权益/预算与联调。
