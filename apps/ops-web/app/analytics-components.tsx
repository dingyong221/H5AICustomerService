import Link from 'next/link';
import type {
  PlatformAnalytics,
  PlatformAssistantUsage,
  PlatformMerchantUsage,
  PlatformQuality,
  PlatformUsage,
  PlatformUsageDay,
} from '@h5cs/database';

import {
  analyticsHref,
  beijingTime,
  completionRate,
  merchantStatusLabel,
  responseDuration,
  type AnalyticsQuery,
} from './analytics-query';

export function AnalyticsUnavailable({
  error = '统计暂不可用，请稍后重试；这不代表没有商家或没有使用数据。',
}: {
  error?: string;
}) {
  return (
    <div className="ops-analytics-error" role="alert">
      <strong>暂时无法显示数据</strong>
      <p>{error}</p>
      <Link href="/reports">重新打开报表</Link>
    </div>
  );
}

export function PeriodFilter({
  query,
  path,
  merchants = false,
  report = false,
}: {
  query: AnalyticsQuery;
  path: string;
  merchants?: boolean;
  report?: boolean;
}) {
  const today = query.today;
  return (
    <section className="ops-filter-panel" aria-label="统计筛选">
      <div className="ops-period-links">
        <strong>统计区间</strong>
        {[1, 7, 30, 90].map((days) => (
          <Link key={days} href={analyticsHref(path, query, { from: null, to: null, days })}>
            {days === 1 ? '今天' : `近 ${days} 天`}
          </Link>
        ))}
        <span>北京时间 · 今天为截至查询时的部分数据</span>
      </div>
      <form key={analyticsHref(path, query)} className="ops-analytics-filter" method="get">
        <label>
          开始日期
          <input
            type="date"
            name="from"
            defaultValue={query.range.from}
            required
            min="2000-01-01"
            max={today}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            name="to"
            defaultValue={query.range.to}
            required
            min="2000-01-01"
            max={today}
          />
        </label>
        {merchants ? (
          <>
            <label className="ops-search-field">
              商家名称或完整 ID
              <input
                name="q"
                type="search"
                defaultValue={query.filters.search}
                minLength={2}
                maxLength={100}
                placeholder="搜索商家名称或编号"
              />
            </label>
            <label>
              商家状态
              <select name="status" defaultValue={query.filters.status}>
                <option value="all">全部状态</option>
                <option value="pending_owner">等待领取</option>
                <option value="active">已启用</option>
                <option value="paused">已暂停</option>
              </select>
            </label>
            <label>
              期间使用
              <select name="activity" defaultValue={query.filters.activity}>
                <option value="all">全部商家</option>
                <option value="used">有消费者问句</option>
                <option value="unused">无消费者问句</option>
              </select>
            </label>
            <label>
              排序
              <select name="sort" defaultValue={query.filters.sort}>
                <option value="recent">最近开通</option>
                <option value="questions">问句数最多</option>
                <option value="sessions">新会话最多</option>
                <option value="failed">失败问句最多</option>
              </select>
            </label>
          </>
        ) : null}
        {report ? (
          <>
            <input type="hidden" name="report" value={query.report} />
            <label className="ops-search-field">
              限定商家 ID（可留空）
              <input
                name="merchantId"
                pattern="[0-9a-f]{32}"
                defaultValue={query.merchantId ?? ''}
                placeholder="留空查看全平台"
                maxLength={32}
              />
            </label>
          </>
        ) : query.merchantId ? (
          <input type="hidden" name="merchantId" value={query.merchantId} />
        ) : null}
        <button type="submit">应用筛选</button>
        <Link href={path}>重置</Link>
      </form>
    </section>
  );
}

export function UsageCards({
  usage,
  usingMerchants,
}: {
  usage: PlatformUsage;
  usingMerchants?: number;
}) {
  const items = [
    ...(usingMerchants === undefined
      ? []
      : [{ label: '期间使用商家', value: usingMerchants, note: '至少提交 1 条消费者问句' }]),
    { label: '新建消费者会话', value: usage.sessions, note: '不等于独立消费者人数' },
    { label: '消费者问句', value: usage.questions, note: '按接收时间统计，不含商家试聊' },
    {
      label: '问句处理完成率',
      value: completionRate(usage.completed, usage.failed),
      note: `${usage.completed} 完成 / ${usage.failed} 失败；不代表答对率`,
    },
    { label: '未终结问句', value: usage.pending, note: '当前仍为接收或处理中状态' },
    {
      label: '平均处理耗时',
      value: responseDuration(usage.meanResponseMs),
      note: '完成问句：接收到完成，含排队',
    },
  ];
  return (
    <div className="ops-stat-grid">
      {items.map((item) => (
        <article className="ops-stat-card" key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <small>{item.note}</small>
        </article>
      ))}
    </div>
  );
}

export function InventoryCards({ data }: { data: PlatformAnalytics }) {
  const inventory = data.inventory;
  return (
    <div className="ops-inventory-grid">
      <article>
        <span>累计商家</span>
        <strong>{inventory.merchants}</strong>
        <small>全库计数，不受最近 50 条限制</small>
      </article>
      <article>
        <span>已启用 / 待领取 / 已暂停</span>
        <strong>
          {inventory.enabledMerchants} / {inventory.pendingOwner} / {inventory.pausedMerchants}
        </strong>
        <small>当前状态，不等于期间活跃</small>
      </article>
      <article>
        <span>客服总数 / 已发布</span>
        <strong>
          {inventory.assistants} / {inventory.publishedAssistants}
        </strong>
        <small>数据库状态；不作为实时健康结论</small>
      </article>
    </div>
  );
}

export function UsageTrend({ days }: { days: readonly PlatformUsageDay[] }) {
  const max = Math.max(1, ...days.map((item) => item.questions));
  return (
    <figure className="ops-usage-trend">
      <figcaption>
        消费者问句趋势 <small>按北京时间自然日</small>
      </figcaption>
      <div
        className="ops-trend-bars"
        role="img"
        aria-label={`${days.length} 天消费者问句趋势，准确数值见每日使用表。`}
      >
        {days.map((item) => (
          <div
            key={item.day}
            title={`${item.day}：${item.questions} 条问句，${item.failed} 条失败`}
          >
            <span style={{ height: `${Math.max(1, (item.questions / max) * 100)}%` }} />
            <small>{days.length <= 7 ? item.day.slice(5) : ''}</small>
          </div>
        ))}
      </div>
      <div className="ops-trend-axis">
        <span>{days[0]?.day}</span>
        <span>{days.at(-1)?.day}</span>
      </div>
    </figure>
  );
}

export function DailyUsageTable({ days }: { days: readonly PlatformUsageDay[] }) {
  return (
    <div className="ops-table-scroll" role="region" aria-label="每日使用明细" tabIndex={0}>
      <table className="ops-data-table">
        <caption>每日使用明细 · 零使用日期也显示</caption>
        <thead>
          <tr>
            {[
              '日期',
              '新商家',
              '新会话',
              '问句',
              '完成',
              '失败',
              '未终结',
              '完成率',
              '平均处理耗时',
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((item) => (
            <tr key={item.day}>
              <th scope="row">{item.day}</th>
              <td>{item.newMerchants}</td>
              <td>{item.sessions}</td>
              <td>{item.questions}</td>
              <td>{item.completed}</td>
              <td>{item.failed}</td>
              <td>{item.pending}</td>
              <td>{completionRate(item.completed, item.failed)}</td>
              <td>{responseDuration(item.meanResponseMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MerchantUsageTable({
  rows,
  query,
}: {
  rows: readonly PlatformMerchantUsage[];
  query: AnalyticsQuery;
}) {
  return (
    <div className="ops-table-scroll" role="region" aria-label="商家使用明细" tabIndex={0}>
      <table className="ops-data-table">
        <thead>
          <tr>
            {[
              '商家',
              '当前状态',
              '客服 / 已发布',
              '新会话',
              '问句',
              '失败',
              '最近消费者问句',
              '操作',
            ].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <th scope="row">
                <Link
                  href={analyticsHref(`/merchants/${item.id}`, query, {
                    q: null,
                    status: null,
                    activity: null,
                    sort: null,
                    merchantId: null,
                    report: null,
                  })}
                >
                  {item.name}
                </Link>
                <code>{item.id}</code>
              </th>
              <td>
                <span
                  className={`ops-state ops-state--${item.status === 'active' ? 'active' : 'other'}`}
                >
                  {merchantStatusLabel(item.status)}
                </span>
              </td>
              <td>
                {item.assistants} / {item.publishedAssistants}
              </td>
              <td>{item.sessions}</td>
              <td>{item.questions}</td>
              <td>{item.failed}</td>
              <td>{beijingTime(item.lastConsultationAt)}</td>
              <td>
                <Link
                  href={analyticsHref(`/merchants/${item.id}`, query, {
                    q: null,
                    status: null,
                    activity: null,
                    sort: null,
                    merchantId: null,
                    report: null,
                  })}
                >
                  查看详情
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AssistantUsageTable({
  rows,
  query,
}: {
  rows: readonly PlatformAssistantUsage[];
  query: AnalyticsQuery;
}) {
  return (
    <div className="ops-table-scroll" role="region" aria-label="客服使用明细" tabIndex={0}>
      <table className="ops-data-table">
        <thead>
          <tr>
            {['客服', '所属商家', '发布状态', '新会话', '问句', '完成', '失败', '平均处理耗时'].map(
              (label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <th scope="row">
                {item.displayName}
                <code>{item.id}</code>
              </th>
              <td>
                <Link
                  href={analyticsHref(`/merchants/${item.merchantId}`, query, {
                    merchantId: null,
                    report: null,
                  })}
                >
                  {item.merchantName}
                </Link>
              </td>
              <td>
                {item.status === 'active' && item.releaseId
                  ? '已发布'
                  : item.status === 'paused'
                    ? '已暂停'
                    : '未发布'}
              </td>
              <td>{item.sessions}</td>
              <td>{item.questions}</td>
              <td>{item.completed}</td>
              <td>{item.failed}</td>
              <td>{responseDuration(item.meanResponseMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  query,
  path,
  total,
  pageSize = 20,
}: {
  query: AnalyticsQuery;
  path: string;
  total: number;
  pageSize?: number;
}) {
  const pages = Math.ceil(total / pageSize);
  return (
    <nav className="ops-pagination" aria-label="数据分页">
      <span>
        共 {total} 条 · 第 {query.page} 页 / 共 {Math.max(1, pages)} 页
      </span>
      {query.page > 1 ? (
        <Link href={analyticsHref(path, query, { page: query.page - 1 })}>上一页</Link>
      ) : null}
      {query.page < pages && query.page < 100_000 ? (
        <Link href={analyticsHref(path, query, { page: query.page + 1 })}>下一页</Link>
      ) : null}
      {query.page > Math.max(1, pages) ? (
        <Link href={analyticsHref(path, query)}>返回第一页</Link>
      ) : null}
    </nav>
  );
}

export function QualitySummary({ data }: { data: PlatformQuality }) {
  return (
    <>
      <div className="ops-stat-grid">
        {[
          ['新建改进任务', data.improvements],
          ['当前任务版本已发布', data.publishedImprovements],
          ['复测运行次数', data.evaluations],
          ['模型调用完成 / 失败', `${data.evaluationCompleted} / ${data.evaluationFailed}`],
          ['商家评审通过 / 不通过', `${data.verdictPass} / ${data.verdictFail}`],
          ['完成待评审 / 仍待完成', `${data.unreviewed} / ${data.evaluationPending}`],
        ].map(([label, value]) => (
          <article className="ops-stat-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <p className="ops-muted">
        按任务／复测创建日期入选，展示查询时的状态；重复复测分别计次。商家评审不是自动评测准确率，历史已过期的评审仍属于其原运行记录。
      </p>
    </>
  );
}

export function ErrorDistribution({ data }: { data: PlatformAnalytics }) {
  return (
    <>
      <p>
        按期内创建记录的当前失败状态统计；同一故障可能同时形成失败问句和失败任务，两类不能相加为总失败数。
      </p>
      {data.errors.length === 0 ? (
        <p className="ops-empty">当前筛选范围内没有失败记录。</p>
      ) : (
        <div className="ops-table-scroll" role="region" aria-label="异常分布" tabIndex={0}>
          <table className="ops-data-table">
            <thead>
              <tr>
                <th scope="col">来源</th>
                <th scope="col">类型</th>
                <th scope="col">错误码</th>
                <th scope="col">数量</th>
              </tr>
            </thead>
            <tbody>
              {data.errors.slice(0, 50).map((item, index) => (
                <tr key={`${item.source}-${index}`}>
                  <td>{item.source === 'conversation' ? '消费者问句' : '后台任务'}</td>
                  <td>{item.type}</td>
                  <td>
                    <code>{item.code}</code>
                  </td>
                  <td>{item.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.errors.length > 50 ? (
        <p>页面显示数量最多的前 50 组；完整结果可导出（上限 5,000 组，超出不生成部分文件）。</p>
      ) : null}
    </>
  );
}

export function MetricNotes() {
  return (
    <details className="ops-metric-notes" id="metric-notes">
      <summary>查看统计口径与数据边界</summary>
      <dl>
        <dt>时间与范围</dt>
        <dd>
          所有日期按北京时间自然日，结束日包含当天，最多 93
          天。当天是部分数据。当前商家／客服数量不受日期区间限制；用量按记录创建时间入选。
        </dd>
        <dt>会话与问句</dt>
        <dd>
          新会话按会话创建日统计，问句按消费者消息接收日统计；旧会话在新日期追加的问句仍计入新日期。只统计公开
          H5 数据，包含从公开 H5
          发送的测试咨询；发布前试聊、资料助手、复测不算消费者问句。会话数不是独立访客数。
        </dd>
        <dt>完成率与耗时</dt>
        <dd>
          完成率＝完成问句÷（完成＋失败问句），未终结问句不进入分母，无终结样本显示“—”。按查询时状态归属到问句接收日。平均耗时为有有效完成时间的已完成问句从接收到完成的时间，包含排队，不是首字延迟或答案正确率。
        </dd>
        <dt>商家使用与管理</dt>
        <dd>
          期间使用商家＝期内至少提交一条消费者问句的商家，包含已暂停商家的历史用量。最近消费者问句时间不受所选日期限制。“已启用”是账号状态，不是登录在线或业务活跃。查看运营统计不会赋予商家管理权限。
        </dd>
        <dt>尚未采集的指标</dt>
        <dd>
          满意度、真实解决率、订单成交与销售额、Token
          和模型费用暂未接入，不能从问句数估算。这里不显示伪造的 0 元费用或满意度。
        </dd>
        <dt>导出与隐私</dt>
        <dd>
          CSV
          为当前筛选范围的汇总数据，不含手机号、密码、令牌、咨询正文。商家／客服导出不受页面分页限制，上限
          5,000 条，超出需缩小筛选；下载后请妥善保管。
        </dd>
      </dl>
    </details>
  );
}
