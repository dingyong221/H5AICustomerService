# 当前工作交接

更新时间：2026-10-25（Asia/Shanghai）。用户已恢复工作，当前准备远程CI与测试发布；本轮尚未部署。

## 目标与验收

每商家一个AI客服，管理/修订/发布保持同一身份和消费者固定链接；消费者各自上下文独立，可在同浏览器有效期内恢复。需求见docs/product/single-assistant-consumer-context-2026-10-25.md，实施/证据/失败历史见docs/development/single-assistant-context-2026-10-25.md。

## 已验证与当前状态

唯一绑定、商家锁、重复/并发复用、管理/知识/改善/公开会话范围、直接管理菜单、浏览器恢复引用及模型12完整轮/16000字符预算已实现。历史行不删除，多个已发布历史歧义须在DDL前停下。普通发布保留旧会话快照，紧急撤回保留。

本地run-1792919142511通过：新增MySQL4项、原治理8项、API25项、桌面/390px手机各14阶段；14→15迁移前后32旧表行/结构保持，浏览器后原行仍在，34表独立恢复摘要一致。回环模型28次，真实供应商0次。最终全仓lint/typecheck/unit/format通过；质量工具57通过/1个Windows跳过，数据库259通过/1跳过。原暂停/失败日志保留，手机是Chrome模拟，未验iOS/微信真机。

现网仍979c9c25c04ed17153fb44d9407eadae0a221cd6（PR #21），14迁移；上次只读五服务健康、17条历史客服、队列/在途0/0。本轮未写服务器。新增0014即第15迁移，33业务表+tracker；不能运行旧979/14硬编码发布控制器。

## 工作区与下一步

实现树R：F:/WorkStation/CODEX/worktrees/materials-publish-integration/H5AICustomerService；codex/one-assistant-context，基线979。证据R/artifacts/single-assistant-context-20261025/。主区旧codex/platform-provisioning和用户脏修改保留；主区AGENTS/HANDOFF/docs/README为跨线程入口。

下一步提交中文PR、远程CI、同域候选，再按既有测试发布授权复核现场重复记录/原链接、备份与迁移、更新服务，完成真实千问的两消费者和续聊验证。当前只做了只读连通：GHCR可达401，SSH实际来源114.92.10.197；重连失败仍先核出口/专属安全组。

遵循现有Web/同域分路径/MySQL/千问、专属SSH、正式HTTPS和数据保留；不新增收费资源/支付/短信/WorkBuddy。无离机备份仅限原受控试运行，不晚于11月3日。A6独立副本未合并，后续追加迁移并复用唯一绑定；真实超市联通仍待相关资料。本轮完成发布前不可称已上线。
