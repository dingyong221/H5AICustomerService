# 当前工作交接

更新时间：2026-10-25（Asia/Shanghai）。用户已明确继续；从本地整体验收恢复，尚未提交、推送或部署本轮调整。

## 当前目标与验收

每商家仅一个AI客服，所有修改/发布保持同一身份和消费者固定链接；不同消费者的上下文独立，允许有效期内同浏览器恢复。详细规则见docs/product/single-assistant-consumer-context-2026-10-25.md，实施/失败/证据及恢复步骤见docs/development/single-assistant-context-2026-10-25.md。

## 当前状态

- 已实现未部署：merchant_assistant唯一绑定、商家事务锁与重复创建复用、管理/知识/改善/公开会话作用域、后台直达唯一客服、浏览器恢复引用、模型最近12轮/16000字预算。历史行不删除，普通发布固定会话版本，紧急撤回保留。
- 已验证：数据库单元259通过/1跳过；商家361、消费者60、Worker102通过；相关类型检查、前后端构建通过。真实MySQL新增3项、原治理8项及API25项通过，包括10并发首次创建、12并发复用、跨消费者与商家隔离。单元批次先后范围见实施记录。
- 尚未完成：桌面/手机浏览器整体验收、独立备份恢复、本轮远程CI/PR/镜像/部署及真实千问上下文复核。最后run-1792900674878在桌面验收中被用户暂停，没有result.json，不称页面验收通过。暂停后没有相关本地端口监听，进程/数据文件保留。
- 现网仍为979c9c25c04ed17153fb44d9407eadae0a221cd6（PR #21），14迁移。11:57只读核验五服务健康、17客服、队列/在途0/0，磁盘约3.66GB；没有修改服务器。本轮一个商家历史“已发布+未发布草稿”应绑定已发布客服；多份已发布须预检停止，不能自动合并。

## 工作区、约束与下一步

实现树R：F:/WorkStation/CODEX/worktrees/materials-publish-integration/H5AICustomerService；分支codex/one-assistant-context，基线979c9c2，改动全部未提交。证据R/artifacts/single-assistant-context-20261025/。主区旧分支codex/platform-provisioning及用户脏修改保留；旧交接已归档。

恢复先读入口及实施记录，检查最后浏览器progress/log，再续验，不能重跑上轮979切流控制器。本轮新增0014即第15条迁移，业务33表+tracker；旧14迁移/32业务表脚本不能照搬。测试生成目录在D:/H5AI-local-verification/20261025/，本地盘空间较低；不得误删业务或用户文件。

继续遵循专属SSH/安全组、HTTPS、内部MySQL、Web同域分路径、千问密钥隔离及既有测试发布授权；不新增收费资源、支付、短信或WorkBuddy。单机无离机备份受控试运行截止不晚于11月3日。上一轮发布证据docs/operations/2026-10-25-business-governance-release-result.md。A6独立副本尚未合并，需追加迁移并复用唯一绑定，入口docs/product/ai-supermarket/handoff.md。
