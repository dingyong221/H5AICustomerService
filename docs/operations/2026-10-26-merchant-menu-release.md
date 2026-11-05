# 商家端统一AI客服管理入口

更新时间：2026-10-26 02:03（Asia/Shanghai）。已实现、已验证、已部署。

- 侧栏“我的AI客服”和“创建客服”合并为唯一“AI客服管理”；原管理入口沿用 /{merchantId}/drafts。已有客服跳转原客服资料，首次使用在管理页按引导开通。返回链接、工作台入口、页面标题和帮助中心同步；首次表单的初始化提交按钮保留。
- PR [#23](https://github.com/dingyong221/H5AICustomerService/pull/23) 已合并。业务源码580d5050541919078c9419eb57670b7c68388b7b，main合并提交db1cce6cf108555f94b860543ae5ab3ee2992309，两者完整树一致e65f1982dc5591be5cb869e4d133d78f6ed587f2。商家端lint/typecheck/361测试、端到端类型检查/格式，以及[PR四项CI](https://github.com/dingyong221/H5AICustomerService/actions/runs/40217475634)成功；没有为菜单新增机械单元测试，只更新现有断言。首轮本地帮助日期断言同步后复验通过，原日志保留。
- [单商家端构建导出](https://github.com/dingyong221/H5AICustomerService/actions/runs/40218144327)成功，使用既有Dockerfile与同域路径，运行限制及材料解析冒烟、save/remove/load往返通过。不向工作站或服务器提供新PAT。临时transport分支只改workflow，不合并主线。首次工作流因job.env引用runner.temp在执行前失败，修正合法上下文后重新执行，旧失败记录保留。
- 官方artifact 12608004683，ZIP 329520551字节，sha256:b24fb9ae884cc28a53f9d2dc82e34c5c3bff19b3738a4bccd2036f4b7473b76c。服务器经专属SSH内存取得单artifact短时下载地址，核验完整ZIP/CRC、gzip、config、每层DiffID、OCI引用及Docker兼容元数据后导入。首轮严格图验证发现未识别的兼容元数据并停止，在完整证明后使用v2校验器完成，未在失败状态导入。未独立验证签名attestation，不作此声称。
- 仅替换merchant-web，镜像sha256:682a5919d211368ae09538ae1f10bdb59531479c22d6a15b9fe9a77c803f31d3，容器417fcf22a25bc06d3143cbbd656f27099469e2eb5c3cbed4272db7a84cdd6f20，healthy；完成时间2026-10-25T18:03:15.939466+00:00。保留原镜像可回退，其他全部容器、数据库15迁移、18条历史客服记录/固定地址/发布指针、Nginx、有效环境与容器权限/端口/挂载/网络均核对保持。没有数据库迁移或业务资料写入；原绑定及消费者上下文逻辑不变。
- 公网正式TLS下，桌面与390px触屏模拟均显示唯一“AI客服管理”，不再显示“创建客服”菜单；登录边界保持，既有合成客服固定地址200。本轮不请求千问、不新增商家/客服；真实iOS/微信未专项验收。

## 证据及恢复

主线[四项CI](https://github.com/dingyong221/H5AICustomerService/actions/runs/40218381565)亦已成功。首次切换后校验因Docker返回挂载列表顺序不稳定而报错；只读诊断确认新商家端已healthy、所有挂载条目和其他保护项完全一致。按挂载目标排序后重新核对并保存完成回执，没有重复执行Compose或再次替换服务。实际完成时间为2026-10-26 02:03:15（Asia/Shanghai）。

证据：F:\WorkStation\CODEX\worktrees\materials-publish-integration\H5AICustomerService/artifacts/menu-management-20261026/，重点switch-completed.json、browser-smoke.json、desktop-menu.png、mobile-menu.png、import-completed.json、frozen-artifact.json；旧失败日志与图校验器保留。服务器root受限记录：/opt/h5-ai-customer-service/changes/merchant-menu-20261026/，含原商家端容器配置（有敏感环境，仅服务器保存）、导入图证明、单服务Compose覆盖与切换回执。临时RAM归档已释放，服务器最终可用2436542464字节。

回退仅需在原Compose链上使用原merchant镜像，执行merchant-web的no-deps单服务替换；不要回退数据库、停止其他服务或重放旧迁移控制器。用户原有主工作区脏修改保留。无离机备份受控试运行原期限2026-11-03T15:59:59Z不变；AI超市、支付、短信、WorkBuddy和模型切换不在此范围。
