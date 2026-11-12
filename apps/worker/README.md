# Worker 阶段 1 运行边界

本目录是本地候选，尚未生产部署。回归使用合成数据和本地模型夹具；真实 Qwen 的 3/6/9 路时延、语义及私有环境切换验收尚未完成。

## 容量与启动

- 首版只运行 **一个模型执行实例**。消费者、试聊、写作、知识整理共享同一个 `ModelRuntime`，默认 2 槽、最多 64 个本地等待项。禁止增加独立 Worker 副本后仍把每实例 2 槽当成全局 2 槽。
- 同商家可借用两槽；商家按稳定 ID 轮转。写作/整理合计最多占一槽，等待管理任务被同商家交互任务越过 3 次后优先获得该商家的下一次机会。
- DB 商家队首排在共享队列中，选中时才领取租约；满队列不跳过尚未入队的队首。排队取消不建立供应商收据或预留费用。有任务完成即补领，无任务时退避 100–2000ms。
- 健康 HTTP 先监听；数据库、调用收据表及新增任务字段可查询后才能就绪。缺少迁移 `0018_runtime_claim_receipts.sql` 时保持 `/readyz` 503，不领取任务。
- 每次实际调用前串行核查持久风险并建立 `model_call_attempt`。风险阈值默认 2，计入 `dispatched` 和 `unknown`，重启不清零。正常两路已知在途也会使计数为 2，这是满载；健康探针扣除本实例已知在途后才判断遗留风险刹车，实际派发仍严格要求持久计数 `< 2`。两个遗留未知/未完成收据会阻止重启后就绪。
- 遗留风险同时占用有效执行容量，在授予本地许可、领取 DB 任务前核查。例如遗留未知 1 个加本地在途 1 个时，其余队首继续等待，不递增领取次数。最终派发准入若遇风险变化，未派发任务 CAS 释放回待处理；100ms 有界重查避免忙循环消耗重试次数。已知在途结束后立即重新检查容量。
- `markDispatch` 对具备权益的商家在同一事务预留一次原有额度；此链路不再额外调用 `reserveModelCall`。确定性回答先检查权限，随后直接回答，不建立供应商收据或扣供应商额度。

本地槽位限制不等于供应商实际在途硬上限：本地超时/断开后供应商仍可能继续执行。未知结果保留风险和费用预留，不自动退款或重新请求。

## 时间预算与切换

消费者任务预算 75 秒。同步试聊/写作/整理的 Worker HTTP 总预算为 20 秒（包含等待共享容量），先于商家服务的 25 秒上游超时及浏览器的 30 秒预算结束；同步请求可能因排队超时而失败，阶段 2 异步能力另行解决。排队超时或客户端断开会撤销尚未派发的请求，不预留费用；已派发后超时保守记为未知。

停止时并行关闭准入/领取/健康探针及 HTTP 监听，允许已选任务在 85 秒内排空，超限再中断，并最多用 5 秒收尾。数据库永久挂起或 HTTP 未结束也不能拖延这 90 秒总预算；剩余 HTTP 连接随后关闭。只有服务 `main` 在限时最佳努力后显式退出，并有 95 秒硬退出 watchdog，避免挂起 DB socket 维持进程。Compose 为 Worker 设置 100 秒停止宽限，DB 领取租约 120 秒。退出不清空未知收据或租约；旧代次和过期租约不能提交迟到结果。

切换前先让旧 Worker 停领并 drain，核对在途、租约和收据后，再按已批准的环境流程升级数据库及启动新 Worker。旧 Worker 不校验新代次，不能与新 Worker 混领 `conversation.turn`。这份本地候选说明不代表已执行私有切换、生产迁移或回滚演练。

## 只读核对与恢复

在已授权且隔离正确的数据库连接内，可用以下只读查询核对状态；凭据按现有环境机制提供，不写入本目录或日志：

```sql
SELECT state, COUNT(*) AS total
FROM model_call_attempt
GROUP BY state;

SELECT HEX(id) AS attempt_id, HEX(merchant_id) AS merchant_id,
       HEX(job_id) AS job_id, CAST(claim_generation AS CHAR) AS claim_generation,
       operation, state, provider_request_id, created_at, updated_at, completed_at
FROM model_call_attempt
WHERE state IN ('dispatched', 'unknown')
ORDER BY created_at, id
LIMIT 100;

SELECT HEX(id) AS job_id, HEX(merchant_id) AS merchant_id, state,
       CAST(claim_generation AS CHAR) AS claim_generation,
       lease_owner, lease_until, model_outcome, HEX(model_attempt_id) AS model_attempt_id,
       last_error_code
FROM job
WHERE type = 'conversation.turn' AND state = 'processing'
ORDER BY lease_until, id
LIMIT 100;
```

收据派发提交响应丢失时，不调用供应商，先按任务代次读取 `reconcile`；完成提交响应丢失时也先读取，不覆盖已完成或新代次结果。无派发证据且 CAS 仍有效的任务才能释放回待处理；已有派发/未知结果不会自动重发。超时后的迟到答案不再提交业务消息。

未知收据不得清表、按时钟自动清零、自动退款或盲目重发。恢复需核对可信供应商记录、请求标识、任务作用域与当前代次，再由授权恢复流程处理具体收据；本阶段没有新增运营恢复 UI 或自动巡检。
