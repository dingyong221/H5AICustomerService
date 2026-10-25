# 当前工作交接

更新时间：2026-10-25 19:09（Asia/Shanghai）。本轮“每商家唯一客服与消费者独立上下文”已完成实现、验证和服务器发布，不要重复旧发布或旧失败动作。

## 已部署及验收

业务源码89beba52a3152af54e322d6fab6402bff6f0e452，PR #22已合并；主线CI40182086836四项、同域候选40182089583八项、离线导出40183086663成功。18:58:21开闸，五服务healthy、15迁移、33业务表+tracker；队列/在途0/0。实际结果/备份/收据见docs/operations/2026-10-25-single-assistant-context-release.md。

每商家只有一个当前客服绑定；手工/引导、重复/并发请求复用原身份，管理/知识/改善/发布均围绕它。全部原17地址及发布指针保留，原13在线/4未发布状态保持；原32业务表在迁移前后行/结构摘要保持。当前17绑定、18历史assistant行，1个旧未发布草稿保留原始行、不再作为第二客服。

本地新增MySQL4项、治理8项、API25项、桌面/手机模拟各14阶段、34表独立实例恢复及全仓检查通过。服务器备份在隔离schema恢复，32旧表摘要一致。真实千问通过A/B独立上下文、关标签后恢复、主动新咨询重置及公网问答。最终私有7条审阅结果，另1条首轮已完成探针结果，公网1条；无供应商逐请求账单，不称精确扣费。

## 文件与工作区

入口仍AGENTS→本文件→docs/README。需求docs/product/single-assistant-consumer-context-2026-10-25.md；实现docs/development/single-assistant-context-2026-10-25.md；详细发布记录如上。R=F:/WorkStation/CODEX/worktrees/materials-publish-integration/H5AICustomerService；业务main89，当前记录分支codex/one-assistant-release-record。证据R/artifacts/single-assistant-context-20261025/，重点final-production-verification.json、private/public-smoke-result.json。服务器发布根/导入根及备份路径均见发布记录。

主区仍旧codex/platform-provisioning，用户脏修改保留，不作为线上源码。旧交接已归档。5个停用旧验收容器及aee镜像已按用户既有清理授权精确清理；原979和其他运行栈保留。一次性迁移容器及本轮RAM已清理，数据库卷未删除；最终磁盘约3.6GB。SSH实际来源114.92.10.197，连接失败仍先核实时出口和专属安全组。

## 约束与下一步

同域Web/MySQL/千问和专属SSH/正式TLS不变；不新增收费资源、支付、短信或WorkBuddy。会话30分钟无新提问到期，同浏览器可恢复，跨设备不自动关联。固定客服链接不因会话结束变化。无离机备份受控试运行不晚于11月3日；未验iOS/微信真机及总体语义质量。A6独立副本未合并，须追加到15迁移后并复用唯一绑定，仍待超市资料/身份权益/预算。后续按新需求推进，本轮没有待部署事项。
