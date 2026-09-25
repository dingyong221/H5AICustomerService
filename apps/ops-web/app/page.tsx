import { randomUUID } from 'node:crypto';

import { Button, EmptyState, PageShell, StatusBadge } from '@h5cs/ui';
import { loadDatabaseConfig, MySqlPlatformProvisioningRepository } from '@h5cs/database';
import { redirect } from 'next/navigation';

import { currentOperator, logoutOperator } from './operator-actions';
import { ManagementLink } from './management-link';
import { managementBaseUrl, merchantWorkspaceUrl } from './management-url';
import { ProvisionForm } from './provision-form';
import { ReissueInvitationForm } from './reissue-invitation-form';

export const dynamic = 'force-dynamic';

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
    description: '追溯商家开通、领取链接重签等平台运营动作。',
    href: '#audit-log',
    icon: <ShieldIcon />,
    id: 'audit',
    label: '访问与审计',
  },
];

export default async function OperationsDashboardPage() {
  const operator = await currentOperator();
  if (!operator) redirect('/login');
  const database = loadDatabaseConfig();
  const managementBase = managementBaseUrl(process.env['MANAGEMENT_CONSOLE_URL']);
  let merchants: Awaited<ReturnType<MySqlPlatformProvisioningRepository['listMerchants']>> = [];
  let audits: Awaited<ReturnType<MySqlPlatformProvisioningRepository['listPlatformAudits']>> = [];
  let databaseReady = false;
  let auditReady = false;
  if (database.configured) {
    const repository = new MySqlPlatformProvisioningRepository(database.config);
    try {
      merchants = await repository.listMerchants();
      databaseReady = true;
    } catch {
      databaseReady = false;
    }
    try {
      audits = await repository.listPlatformAudits();
      auditReady = true;
    } catch {
      auditReady = false;
    }
  }
  return (
    <PageShell
      aside={
        <form action={logoutOperator}>
          <button className="ops-logout" type="submit">
            退出登录
          </button>
        </form>
      }
      description={<p>聚焦商家状态、后台任务与敏感操作审计。消费者内容默认不在运营总览展示。</p>}
      eyebrow="Operations Control"
      notice={
        <div className="ops-connection" role="status">
          <strong>{databaseReady ? `运营账号：${operator}` : '数据库暂不可用'}</strong>
          <span>
            {databaseReady
              ? '商家开通与列表已连接真实数据库；平台操作审计单独显示连接状态，任务面板尚未接入。'
              : '商家开通不可用，请核对 MySQL 连接和迁移状态。'}
          </span>
        </div>
      }
      title="平台运行态，一眼看清"
    >
      <section aria-label="运营数据概况" className="ops-overview" id="overview">
        <div className="ops-overview__lead">
          <p>系统概况</p>
          <strong>{databaseReady ? `${merchants.length} 个商家已载入` : '等待运行数据'}</strong>
          <span>在这里开通商家，生成商家后台领取链接；客服由商家在自己的后台创建和发布。</span>
        </div>
        <div className="ops-metrics">
          <article>
            <span>活跃商家</span>
            <strong>
              {databaseReady
                ? merchants.filter((merchant) => merchant.status === 'active').length
                : '—'}
            </strong>
            <small>{databaseReady ? '当前已载入列表' : '尚未查询'}</small>
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

      <section aria-labelledby="provision-heading" className="ops-provision-panel" id="provision">
        <div className="section-heading">
          <div>
            <p>商家开通</p>
            <h2 id="provision-heading">生成商家后台领取链接</h2>
          </div>
          <StatusBadge tone={databaseReady ? 'info' : 'warning'}>
            {databaseReady ? '数据库已连接' : '暂不可用'}
          </StatusBadge>
        </div>
        <p>创建后商家处于“等待负责人领取”状态；一次性链接不赋予运营以外的管理权限。</p>
        {databaseReady ? <ProvisionForm idempotencyKey={randomUUID()} /> : null}
        {databaseReady ? (
          <div className="ops-merchant-list" id="merchants">
            <h3>最近商家</h3>
            {merchants.length === 0 ? (
              <p>尚无商家记录。</p>
            ) : (
              <ul>
                {merchants.map((merchant) => (
                  <li key={merchant.id}>
                    <strong>{merchant.name}</strong>
                    <span>
                      {merchant.status === 'pending_owner' ? '等待领取' : merchant.status}
                    </span>
                    <small>{merchant.id}</small>
                    {merchant.status === 'pending_owner' ? (
                      <ReissueInvitationForm merchantId={merchant.id} />
                    ) : null}
                    {merchant.status === 'active' && managementBase ? (
                      <ManagementLink href={merchantWorkspaceUrl(managementBase, merchant.id)} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
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
              {area.id === 'audit' && auditReady ? (
                <a className="ops-area-link" href={area.href}>
                  查看记录
                </a>
              ) : (
                <Button disabled size="small" variant="secondary">
                  等待 API
                </Button>
              )}
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="audit-heading" className="attention-panel" id="audit-log">
        <div className="section-heading">
          <div>
            <p>平台操作</p>
            <h2 id="audit-heading">最近审计记录</h2>
          </div>
          <StatusBadge tone={auditReady ? 'info' : 'warning'}>
            {auditReady ? '已连接' : '暂不可用'}
          </StatusBadge>
        </div>
        <p>仅展示平台运营操作的时间、操作人、动作、商家标识和结果；不展示咨询正文或密钥。</p>
        {!auditReady ? (
          <p role="alert">审计记录查询失败，不能据此判断最近没有操作。</p>
        ) : audits.length === 0 ? (
          <p>目前没有平台运营操作记录。</p>
        ) : (
          <ol className="ops-audit-list">
            {audits.map((audit) => (
              <li key={audit.id}>
                <strong>{audit.action}</strong>
                <span>{audit.result}</span>
                <small>操作人：{audit.operatorId}</small>
                {audit.merchantId ? <small>商家：{audit.merchantId}</small> : null}
                <time dateTime={audit.occurredAt.toISOString()}>
                  {audit.occurredAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </time>
              </li>
            ))}
          </ol>
        )}
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
