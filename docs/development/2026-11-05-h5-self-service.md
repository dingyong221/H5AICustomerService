# H5 扫码交付迭代记录

更新时间：2026-11-05。任务：将现有 H5 产品调整为可扫码、注册登录、自助领取并使用的产品，复用现有后台。

## 实现范围

新增原生产品页、商家开通二维码／下载、0 元领取表单、服务端活动资格、注册限流、权益、唯一分配与供应商调用预算。保留 A6 本地合成接口作为严格限定的测试适配器；没有宣称已对接 AI 超市身份或交易。

从已发布业务 main db1cce6／发布记录 0a9a33d 创建独立 Git 工作树 `artifacts/iterations/h5-self-service-delivery`，分支 `codex/h5-self-service-delivery`，合并 11 月 3 日引导改进及 A6 源码，未改主工作区旧源码或用户修改。A6 原迁移未插入历史；沿用前 15 条，新增第 16 条 `0015_clumsy_prowler` 和 7 张业务表，总计 40 业务表及迁移跟踪表。

领取事务按当前 `merchant_assistant` 绑定复用客服，不按历史草稿数量重新选客服；新开通同时写当前绑定、空草稿、权益分配、审计和 outbox。空草稿可编辑但不能确认或发布。账号密码沿用原算法、会话与来源校验。并发测试发现并修复活动行共享锁升级死锁，未更改生产密码算法。

实现、配置、边界及回退要求见 `docs/product/h5-self-service-delivery-2026-11-05.md`；样例 `infra/compose/self-service.env.example` 默认 disabled。

## 已验证

- 商家 369、数据库 265（另 1 跳过）、Worker 108、消费者 61 项单元测试通过；商家和消费者构建通过，商家完整 lint、E2E TypeScript 通过。
- 本机真实 MySQL：原 A6 10 项及新增原生领取 8 项事务测试通过，覆盖新老账号、并发、重复、提交失败／未知结果、额度、停用到期、越权与当前绑定。
- 有历史合成数据的 15→16 迁移、重放和原 33 张表指纹保持通过；现有 CI 的 12→16 升级探针亦在本机真实 MySQL 通过。这不是生产迁移证据。
- 依赖审计不再忽略任何 GHSA，高危／严重均为 0；静态发布策略通过。原 GHSA-vfj7-8cjw-p6xm 已于 10 月 23 日被官方撤回，旧批准记录移入 retiredExceptions，不延长原例外。来源：https://github.com/advisories/GHSA-vfj7-8cjw-p6xm 。

本地证据位于工作树 `artifacts/`：`merchant-tests-final.log`、`database-tests-final.log`、`worker-tests-serial.log`、`consumer-tests-final.log`、`merchant-build-final2.log`、`consumer-build.log`、`merchant-lint-final2.log`、`dependency-audit-no-ignore.json`、`release-static-no-ignore.log`，真实库 `artifacts/ai-supermarket-a6-stage2/run-1793860190369/`。

## 未完成／验证限制

Windows 内存提交不足导致多服务后的浏览器启动分配失败（1455、ERR_MEMORY_ALLOCATION_FAILED），不能据此认定完整浏览器验收通过。保留失败日志和测试数据；仅核实并终止本轮自有残留进程，没有清理其他项目进程或业务数据。

新增独立 GitHub Actions `H5 self-service acceptance`：临时 loopback MySQL 源／恢复容器，使用本地确定性假模型；覆盖桌面／手机模拟领取→资料→知识→试聊→双版本发布→消费者新旧会话→权益状态→完整备份恢复。等待实际运行结果。模拟手机不等于微信／iOS 真机，假模型不证明千问回答质量。

本记录初次写入时尚未推送、远程验收或部署，线上最后记录仍 10 月 26 日版本。不得将产品页预期网址或本地通过称作公网交付。后续应记录 PR、精确 SHA、CI、制品和部署回读证据。无离机备份的受控试运行授权原期限为 11 月 3 日，未因移除已撤回 GHSA 的忽略规则而续期。
