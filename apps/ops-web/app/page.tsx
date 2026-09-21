import { Button, EmptyState, PageShell, StatusBadge } from '@h5cs/ui';

function BuildingIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M5 20V5l10-2v17M5 8h10M8 11h1m3 0h1m-5 3h1m3 0h1m-5 3h1m3 0h1m2-7h4v10H3h18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M6 5h12M6 12h12M6 19h12M3 5h.01M3 12h.01M3 19h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M12 3 5 6v5c0 4.8 2.8 8.2 7 10 4.2-1.8 7-5.2 7-10V6l-7-3Zm-3 9 2 2 4-5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

const operationAreas = [
  {
    description: '查看商家、客服正式版本、服务状态和试点额度。',
    href: '#merchants',
    icon: <BuildingIcon />,
    id: 'merchants',
    label: '商家与客服',
  },
  {
    description: '定位知识处理、发布和模型调用的失败任务。',
    href: '#tasks',
    icon: <QueueIcon />,
    id: 'tasks',
    label: '任务与异常',
  },
  {
    description: '追溯敏感访问、暂停、额度调整等运营动作。',
    href: '#audit',
    icon: <ShieldIcon />,
    id: 'audit',
    label: '访问与审计',
  },
];

export default function OperationsDashboardPage() {
  return (
    <PageShell
      aside={<StatusBadge tone="warning">API 未连接</StatusBadge>}
      description={<p>聚焦商家状态、后台任务与敏感操作审计。消费者内容默认不在运营总览展示。</p>}
      eyebrow="Operations Control"
      notice={
        <div className="ops-connection" role="status">
          <strong>只读骨架</strong>
          <span>身份、数据和操作接口均未连接，当前页面不会执行暂停、额度调整或审计访问。</span>
        </div>
      }
      title="平台运行态，一眼看清"
    >
      <section aria-label="运营数据概况" className="ops-overview" id="overview">
        <div className="ops-overview__lead">
          <p>系统概况</p>
          <strong>等待运行数据</strong>
          <span>连接运营 API 后展示商家、客服、任务和用量的聚合状态。</span>
        </div>
        <div className="ops-metrics">
          <article>
            <span>活跃商家</span>
            <strong aria-label="尚未获取">—</strong>
            <small>尚未查询</small>
          </article>
          <article>
            <span>运行中任务</span>
            <strong aria-label="尚未获取">—</strong>
            <small>尚未查询</small>
          </article>
          <article>
            <span>待处置异常</span>
            <strong aria-label="尚未获取">—</strong>
            <small>尚未查询</small>
          </article>
        </div>
      </section>

      <section aria-labelledby="areas-heading" className="operation-areas">
        <div className="section-heading">
          <div>
            <p>运营入口</p>
            <h2 id="areas-heading">按职责进入对应工作区</h2>
          </div>
          <small>所有敏感操作必须由服务端鉴权并留痕</small>
        </div>
        <div className="operation-area-grid">
          {operationAreas.map((area) => (
            <article className="operation-area-card" id={area.id} key={area.id}>
              <div aria-hidden="true" className="operation-area-card__icon">
                {area.icon}
              </div>
              <div>
                <h3>{area.label}</h3>
                <p>{area.description}</p>
              </div>
              <Button disabled size="small" variant="secondary">
                等待 API
              </Button>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="attention-heading" className="attention-panel">
        <div className="section-heading">
          <div>
            <p>待处理</p>
            <h2 id="attention-heading">异常与人工处置</h2>
          </div>
          <StatusBadge>未载入</StatusBadge>
        </div>
        <EmptyState
          description={<p>尚未连接任务与告警 API，不能据此判断当前是否存在异常或待审核事项。</p>}
          icon={<QueueIcon />}
          title="暂无可展示的运行数据"
        />
      </section>
    </PageShell>
  );
}
