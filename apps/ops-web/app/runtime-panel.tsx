import {
  loadDatabaseConfig,
  MySqlRuntimeExecutionControlRepository,
  MySqlRuntimeObservationRepository,
} from '@h5cs/database';
import type {
  RuntimeControlView,
  RuntimeObservation,
  RuntimeObservationQuery,
  RuntimeScope,
  RuntimeTimingSummary,
} from '@h5cs/contracts';
import type { AnalyticsParams } from './analytics-query';
import { currentOperator } from './operator-actions';
import { RuntimeControlForm } from './runtime-control-form';
import { readWorkerObservation } from './runtime-observation';

const types = ['conversation.turn', 'knowledge.organize', 'draft.expand', 'preview.reply'] as const;
export function runtimeQuery(params: AnalyticsParams, now = new Date()): RuntimeObservationQuery {
  const get = (key: string) => {
    const value = params[key];
    if (Array.isArray(value)) throw Error('运行筛选项不能重复填写。');
    return value;
  };
  const parse = (value: string | undefined, fallback: Date) => {
    if (value === undefined) return fallback;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?Z)?$/u.test(value))
      throw Error('请填写完整的 UTC 起止时间。');
    const date = new Date(value.endsWith('Z') ? value : `${value}Z`);
    if (!Number.isFinite(date.getTime())) throw Error('运行筛选时间无效。');
    return date;
  };
  const from = parse(get('runtimeFrom'), new Date(now.getTime() - 86400000));
  const to = parse(get('runtimeTo'), now);
  if (to <= from || to.getTime() - from.getTime() > 31 * 86400000)
    throw Error('运行观测时间窗口须大于零且不超过 31 天。');
  const merchantId = get('runtimeMerchant') || undefined;
  const type = get('runtimeType') || undefined;
  const cursor = get('runtimeCursor') || undefined;
  if (merchantId && !/^[a-f0-9]{32}$/u.test(merchantId))
    throw Error('请填写完整的 32 位小写商家 ID。');
  if (type && !types.includes(type as (typeof types)[number])) throw Error('任务类型无效。');
  if (cursor && cursor.length > 1024) throw Error('分页标识无效。');
  return {
    from,
    to,
    limit: 20,
    ...(merchantId ? { merchantId } : {}),
    ...(type ? { type: type as (typeof types)[number] } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
function Timing({ label, data }: { label: string; data: RuntimeTimingSummary }) {
  return (
    <div>
      <strong>{label}</strong>
      <p>
        样本 {data.sampleCount} / 已检查 {data.examinedCount}，排除 {data.excludedCount}
        {data.truncated ? '；已截断，仅最新 1000 个任务' : ''}
      </p>
      <p>
        P50 {data.p50Ms === null ? '—' : `${data.p50Ms} ms`} · P95{' '}
        {data.p95Ms === null ? '—' : `${data.p95Ms} ms`} · 最大{' '}
        {data.maxMs === null ? '—' : `${data.maxMs} ms`}
      </p>
    </div>
  );
}
export async function RuntimeScopeControl({
  scope,
  label,
  controllable = true,
}: {
  scope: RuntimeScope;
  label: string;
  controllable?: boolean;
}) {
  const operator = await currentOperator();
  if (!operator) return null;
  const database = loadDatabaseConfig();
  let view: RuntimeControlView | null = null;
  if (database.configured) {
    try {
      view = await new MySqlRuntimeExecutionControlRepository(database.config).read(scope);
    } catch {
      /* Fail closed. */
    }
  }
  return (
    <RuntimeControlForm
      key={`${view?.scopeKey}:${view?.revision}`}
      view={view}
      scope={scope}
      label={label}
      operatorId={operator}
      controllable={controllable || view?.state === 'manually_stopped'}
    />
  );
}
export async function RuntimePanel({ params }: { params: AnalyticsParams }) {
  if (!(await currentOperator())) return null;
  let query: RuntimeObservationQuery;
  try {
    query = runtimeQuery(params);
  } catch (error) {
    return <p role="alert">{error instanceof Error ? error.message : '运行观测筛选无效。'}</p>;
  }
  const database = loadDatabaseConfig();
  let observation: RuntimeObservation | null = null;
  if (database.configured) {
    try {
      observation = await new MySqlRuntimeObservationRepository(database.config).read(query);
    } catch {
      /* Unavailable is never zero. */
    }
  }
  const worker = await readWorkerObservation();
  const snapshot = worker.snapshot;
  const dateInput = (date: Date) => date.toISOString().slice(0, 16);
  const next = new URLSearchParams({
    runtimeFrom: query.from.toISOString(),
    runtimeTo: query.to.toISOString(),
    ...(query.merchantId ? { runtimeMerchant: query.merchantId } : {}),
    ...(query.type ? { runtimeType: query.type } : {}),
    runtimeCursor: observation?.nextCursor ?? '',
  });
  return (
    <div className="runtime-panel">
      <h3>运行控制与观测</h3>
      <RuntimeScopeControl scope={{ kind: 'global' }} label="全局" />
      <form method="get" action="/#tasks" className="runtime-filter" aria-label="运行观测筛选">
        <label>
          起始时间（UTC）
          <input
            type="datetime-local"
            name="runtimeFrom"
            required
            defaultValue={dateInput(query.from)}
          />
        </label>
        <label>
          结束时间（UTC）
          <input
            type="datetime-local"
            name="runtimeTo"
            required
            defaultValue={dateInput(query.to)}
          />
        </label>
        <label>
          商家 ID（可选）
          <input
            name="runtimeMerchant"
            maxLength={32}
            pattern="[a-f0-9]{32}"
            defaultValue={query.merchantId ?? ''}
          />
        </label>
        <label>
          任务类型
          <select name="runtimeType" defaultValue={query.type ?? ''}>
            <option value="">全部类型</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">查询并刷新观测</button>
      </form>
      <div className="runtime-source-grid">
        <article aria-label="数据库运行观测">
          <h3>数据库 · 持久任务与调用收据</h3>
          {observation ? (
            <>
              <p>
                查询时间 {observation.asOf}；窗口 {observation.from} 至 {observation.to}
                （UTC）。任务样本 {observation.sampleCount}。
              </p>
              <dl className="runtime-counts">
                {Object.entries(observation.jobs).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value ?? '—'}</dd>
                  </div>
                ))}
              </dl>
              <h4>调用收据</h4>
              <dl className="runtime-counts">
                {Object.entries(observation.receipts).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p>
                当前权益预留存量 {observation.reservations.reservedCalls} 次；分配权益的商家{' '}
                {observation.reservations.allocatedMerchantCount}{' '}
                个。单位为调用预留次数，不能换算为实际费用；此存量不按时间窗口或任务类型拆分。
              </p>
              <Timing label="受理至完成" data={observation.timings.acceptedToCompletedMs} />
              <Timing
                label="受理至派发记录"
                data={observation.timings.acceptedToDispatchRecordMs}
              />
              <p>
                时间从持久化受理时刻计算；排除旧迁移收据、unknown
                与缺时刻样本。包含排队等耗时，不能当作纯供应商响应时延。
              </p>
            </>
          ) : (
            <p role="alert">数据库观测查询失败，计数与分位数均未知，不能据此判断没有任务或风险。</p>
          )}
        </article>
        <article aria-label="Worker进程观测">
          <h3>Worker · 单进程即时快照</h3>
          {snapshot ? (
            <>
              <p>
                实例 {snapshot.instanceId} · 启动于 {snapshot.startedAt} · 观测于{' '}
                {snapshot.observedAt}
              </p>
              <p>
                本地模型活动 {snapshot.localModelActive}，本地排队 {snapshot.localQueued}；容量{' '}
                {snapshot.capacity}，管理保留容量 {snapshot.managementCapacity}。
              </p>
              <p>
                进程接收新工作：{snapshot.accepting ? '是' : '否'}；运行控制：
                {snapshot.controlEnabled ? '启用' : '关闭'}；控制表探针：
                {snapshot.controlSchemaReady ? '就绪' : '不可用'}；全局持久暂停：
                {snapshot.globalControlState === null
                  ? '未知或控制关闭'
                  : snapshot.globalControlState === 'active'
                    ? '未暂停'
                    : '人工暂停'}
                。
              </p>
              <p>
                未决风险 {snapshot.unresolvedRiskCount ?? '未知'}；风险探针时间{' '}
                {snapshot.riskProbeAt ?? '未取得'}。
              </p>
              <p>
                只代表此实例快照，不与数据库窗口统计相加；accepting
                是进程生命周期状态，人工暂停不表示进程故障。
              </p>
            </>
          ) : (
            <p role="alert">{worker.error}</p>
          )}
        </article>
      </div>
      {observation ? (
        <>
          <h3>窗口内任务元数据（本页最多 20 项）</h3>
          <p>
            只展示运行元数据；不读取任务正文、知识资料或消费者消息。任务暂停不会取消已经发出的调用。
          </p>
          <ol className="ops-job-list runtime-job-list">
            {observation.tasks.map((task) => (
              <li key={task.jobId}>
                <strong>
                  {task.type} · {task.state}
                </strong>
                <code>{task.jobId}</code>
                <p>
                  商家 {task.merchantId ?? '无'} · 模型结果 {task.modelOutcome} · 尝试{' '}
                  {task.attempt} · 领取代次 {task.claimGeneration}
                </p>
                <p>
                  受理 {task.createdAt} · 完成 {task.completedAt ?? '—'} · 错误码{' '}
                  {task.lastErrorCode ?? '—'}
                </p>
                <RuntimeScopeControl
                  scope={{ kind: 'job', jobId: task.jobId }}
                  label="此任务"
                  controllable={['pending', 'processing'].includes(task.state)}
                />
              </li>
            ))}
          </ol>
          {!observation.tasks.length ? <p>此筛选与当前页没有任务记录。</p> : null}
          {observation.nextCursor ? (
            <a href={`/?${next.toString()}#tasks`}>查看下一页任务</a>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
