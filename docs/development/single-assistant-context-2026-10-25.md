# 2026-10-25 唯一客服与消费者上下文调整

更新时间：2026-10-25（Asia/Shanghai）。用户已恢复工作，以下补充本地里程碑；本轮尚未部署。暂停时记录保留为历史，不代表当前状态。产品规则见../product/single-assistant-consumer-context-2026-10-25.md。

## 已实现

工作树：F:/WorkStation/CODEX/worktrees/materials-publish-integration/H5AICustomerService，codex/one-assistant-context，基于origin/main 979c9c25c04ed17153fb44d9407eadae0a221cd6。

- packages/database新增merchant_assistant：merchant_id主键、同商家客服复合外键；创建先锁商家，手工/引导共用绑定。已有客服返回原身份，不覆盖新输入；旧表保留，优先绑定唯一历史已发布客服，无发布选最早草稿。多份历史已发布在任何新DDL前停止。0014_flimsy_swarm.sql为第15条迁移，应用后33业务表加tracker共34表。
- 管理、知识、改善、历史版本、公开会话和Worker关联当前绑定；运营数量/列表也按绑定统计。历史未绑定草稿保留原行，不再作为第二个可管理/咨询客服。
- 商家工作台围绕单一客服，菜单直接进入各功能，旧new地址返回原客服；并发过期创建表单返回“已开通”，保留输入供复制，避免误报已覆盖。
- 消费者恢复引用从仅sessionStorage扩展到localStorage，仍依赖HttpOnly访客Cookie授权，不存会话授权令牌。不同浏览器/设备不自动视为同人；当前会话30分钟空闲到期，主动新咨询隔断旧上下文。
- Worker模型输入限制为同会话最近12个完整问答轮次及16000字符，服务端完整记录保留；普通发布固定旧会话版本，紧急撤回继续终止旧/在途回复。

## 已验证与未完成

证据根：R/artifacts/single-assistant-context-20261025/（R为上述工作树）。

- database-unit-4.log：259通过，1个Windows跳过；consumer-unit-2.log 60、worker-unit-2.log 102、merchant-unit-2.log 361通过。后续名称/复用提示和报表调整完成类型检查/构建，但结束前需针对最终差异再核对测试范围。
- backend-build.log、merchant-build.log、consumer-build.log及api-typecheck-2.log、merchant-typecheck-2.log、e2e-typecheck.log通过。本地Next输出移至D盘并以junction挂接；输出根下node_modules链接是本机测试适配，不能当发布依赖。
- 真实MySQL新增3项通过：10并发首次创建只落一个，12不同键/两个成员重复请求复用且不覆盖；同客服两个消费者历史独立、伪造引用和跨商家恢复拒绝、新咨询空上下文；原治理8项、API25项通过。升级合成夹具验证歧义在DDL前停止、唯一已发布胜过旧草稿，旧表摘要不变。
- integration/run-1792900674878为最后运行：数据库/API已通过，browser.log仅进入桌面验收时用户暂停，无result.json，未执行独立恢复；paused-by-user.json记录暂停。Ctrl+C后清点manifest中的本轮进程均已退出，3000/3001/3003/3011/4000/9020/33188/33189无监听。文件/数据库目录保留。
- 失败原记录保留：第一轮旧多客服夹具5项失败，改为显式历史未绑定夹具而非放宽权限；第二轮外移.next缺少运行时模块定位，补本机输出node_modules链接；第三轮浏览器测试误期待中转/drafts，但实际直达/drafts/new，修正断言。第四轮尚未完成。
- server-readonly-1792900649498.json：2026-10-25约11:57只读，五服务healthy、14迁移、17客服、队列0/在途0、可用3665707008字节。服务器未写入。

## 恢复工作

1. 等用户明确继续。先检查分支/diff和最后browser.log、desktop-progress.json及页面错误；未证明闭环完成，不能说已发布。
2. 完成最后桌面/手机模拟、原链接/新旧会话/紧急撤回及独立恢复。scripts/quality/run-single-assistant-local.mjs仅允许专用回环CI库，保留其保护；新增真实测试packages/database/test/single-assistant-context.mysql.mjs和single-assistant-upgrade-fixture.mjs。
3. 本机C/D/F空间均较低，生成资料和测试库仅存明确任务路径，后续制品需先核对容量；不清理未核实的用户/生产文件。
4. 最终本地验证后再提交/推送、中文PR、远程CI及同域候选。本轮未创建PR、未发起Actions，也未新读/创建令牌。已有GCM可用助手路径Q/artifacts/ops-enhancement/release-context.mjs的source常量过时，不能直接执行旧发布。
5. 若继续既有测试发布，先现场预检重复/绑定和旧链接；迁移第14→15须调用assertSingleAssistantUpgrade且保持备份与恢复证据。旧979/14控制器全部是历史工具，不自动重跑。发布后真实模型上下文/两消费者复核并清楚记录边界。

原发布与A6约束以主区HANDOFF、docs/README及AGENTS为准。历史交接归档docs/development/handoff-archive/2026-10-25-1202-before-pause.md。

## 恢复后的本地里程碑

- 独占本地运行integration/run-1792919142511成功结束，processes-stopped.json确认所有本轮端口已关闭。14→15迁移、32张旧业务表摘要/行保留、原始数据在浏览器验收后仍保留；唯一已发布客服胜过历史未发布草稿，歧义在DDL前停止。
- 新增真实MySQL4项通过，含引导与手工开通竞态；原治理8项、API25项通过。桌面/390px手机触屏模拟各14个阶段均通过：创建、资料上传整理、同修订试聊发布、两个消费者独立上下文、同浏览器关标签后恢复、主动新咨询空上下文、真实Next返回保护、新版同链接/旧会话快照、改名、撤回和再发布。
- 34表独立恢复摘要完全一致：source/restored SHA256 5a643be298e737781d252f43852dbd6ca04f90988de41e0ad46c9228845580d9；备份SHA256 6a6ea96ebed93c56809078fd0bc29b7f5e190044117a73a9f5ff7d26ec948b49。回环模型28次，真实供应商0次。本地合成回复不当作真实千问质量证明。
- 最终全仓lint、typecheck、unit及格式通过（resume-lint-2.log、resume-typecheck-2.log、resume-unit-2.log、resume-format-check.log）。质量工具58项中57通过/1个POSIX测试在Windows跳过，数据库单元259通过/1个Windows跳过。新增上下文坏数据测试已修正参数化声明，避免数组被展开为单个消息；prompt预算实现收拢到原prompt模块，源/编译一致性探针通过。
- 更新通用浏览器验收的“我的AI客服/开通”定位。独立消费者使用独立浏览器上下文，同浏览器新标签按续聊处理，不能用它代替新消费者。
- 服务器仅做只读连通检查：GHCR返回401（可达、需认证），GitHub/public gateway返回200，SSH实际来源114.92.10.197。没有改动服务器。

下一步：中文PR、远程CI、同域五镜像候选；通过后按已有测试服务器授权做窄范围备份、14→15迁移、服务更新和真实模型上下文复核。尚未完成或验证的阶段不得报为已部署。
