import { randomUUID } from 'node:crypto';

import { Button, EmptyState, PageShell, StatusBadge } from '@h5cs/ui';
import {
  loadDatabaseConfig,
  MySqlIndustryTemplateRepository,
  MySqlPlatformProvisioningRepository,
  type IndustryTemplateGuide,
  type PlatformJobOverview,
} from '@h5cs/database';
import { redirect } from 'next/navigation';

import { currentOperator, logoutOperator } from './operator-actions';
import { DeactivateIndustryTemplateForm } from './deactivate-industry-template-form';
import { ManagementLink } from './management-link';
import { MerchantStatusForm } from './merchant-status-form';
import { IndustryTemplateForm } from './industry-template-form';
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
    description: '查看商家领取状态、客服草稿和正式版本。',
    href: '#assistants',
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

const assistantStateLabel = (status: string, activeReleaseId: string | null): string => {
  if (status === 'active') return activeReleaseId ? '已发布' : '状态待核对';
  if (status === 'paused') return '已暂停';
  if (status === 'draft_only') return '草稿';
  return '其他状态';
};

export default async function OperationsDashboardPage() {
  const operator = await currentOperator();
  if (!operator) redirect('/login');
  const database = loadDatabaseConfig();
  const managementBase = managementBaseUrl(process.env['MANAGEMENT_CONSOLE_URL']);
  let merchants: Awaited<ReturnType<MySqlPlatformProvisioningRepository['listMerchants']>> = [];
  let audits: Awaited<ReturnType<MySqlPlatformProvisioningRepository['listPlatformAudits']>> = [];
  let assistants: Awaited<ReturnType<MySqlPlatformProvisioningRepository['listAssistantStates']>> =
    [];
  let jobs: PlatformJobOverview | null = null;
  let industryTemplates: readonly IndustryTemplateGuide[] = [];
  let databaseReady = false;
  let auditReady = false;
  let assistantsReady = false;
  let industryTemplatesReady = false;
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
    try {
      assistants = await repository.listAssistantStates();
      assistantsReady = true;
    } catch {
      assistantsReady = false;
    }
    try {
      jobs = await repository.jobOverview();
    } catch {
      jobs = null;
    }
    try {
      industryTemplates = await new MySqlIndustryTemplateRepository(database.config).listLatest();
      industryTemplatesReady = true;
    } catch {
      industryTemplatesReady = false;
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
              ? '商家开通与列表已连接真实数据库；审计和任务状态分别显示连接情况。'
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
            <strong>{jobs ? jobs.processing : '—'}</strong>
            <small>{jobs ? `另有 ${jobs.pending} 项待处理` : '暂不可用'}</small>
          </article>
          <article>
            <span>失败任务</span>
            <strong>{jobs ? jobs.failed : '—'}</strong>
            <small>{jobs ? '需人工核对原因' : '暂不可用'}</small>
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
                      {merchant.status === 'pending_owner'
                        ? '等待领取'
                        : merchant.status === 'active'
                          ? '运行中'
                          : merchant.status === 'paused'
                            ? '已暂停'
                            : merchant.status}
                    </span>
                    <small>{merchant.id}</small>
                    {merchant.status === 'pending_owner' ? (
                      <ReissueInvitationForm merchantId={merchant.id} />
                    ) : null}
                    {merchant.status === 'active' && managementBase ? (
                      <ManagementLink href={merchantWorkspaceUrl(managementBase, merchant.id)} />
                    ) : null}
                    {merchant.status === 'active' || merchant.status === 'paused' ? (
                      <details className="ops-merchant-status-control">
                        <summary>{merchant.status === 'active' ? '暂停商家' : '恢复商家'}</summary>
                        <MerchantStatusForm
                          merchantId={merchant.id}
                          paused={merchant.status === 'active'}
                        />
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>

      <section
        aria-labelledby="templates-heading"
        className="ops-provision-panel"
        id="industry-templates"
      >
        <div className="section-heading">
          <div>
            <p>资料引导</p>
            <h2 id="templates-heading">行业模板</h2>
          </div>
          <StatusBadge tone={industryTemplatesReady ? 'info' : 'warning'}>
            {industryTemplatesReady
              ? `${industryTemplates.filter((template) => template.status === 'active').length} 个启用行业`
              : '暂不可用'}
          </StatusBadge>
        </div>
        <p>按行业列出商家应提供的资料和策略。模板是收集问题的参考，不是商家已核实的事实。</p>
        {industryTemplatesReady ? (
          industryTemplates.length === 0 ? (
            <p>尚无行业模板；商家仍可手动填写细分行业与资料。</p>
          ) : (
            <ul className="ops-template-list">
              {industryTemplates.map((template) => (
                <li key={template.id}>
                  <strong>{template.displayName}</strong>
                  <small>
                    {template.code} · v{template.version} ·{' '}
                    {template.status === 'active' ? '已启用' : '已停用'}
                  </small>
                  <details>
                    <summary>查看资料引导</summary>
                    <p>{template.referenceNotes}</p>
                    <p>资料：{template.requiredMaterials.join('；')}</p>
                    <p>售卖策略：{template.requiredPolicies.join('；') || '按业务情况确认'}</p>
                  </details>
                  {template.status === 'active' ? (
                    <details>
                      <summary>停用此行业模板</summary>
                      <DeactivateIndustryTemplateForm id={template.id} />
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : (
          <p role="alert">行业模板查询失败，不能据此判断没有模板。</p>
        )}
        {databaseReady ? (
          <div className="ops-template-create">
            <h3>新增不可变模板版本</h3>
            <IndustryTemplateForm />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="assistants-heading" className="attention-panel" id="assistants">
        <div className="section-heading">
          <div>
            <p>商家与客服</p>
            <h2 id="assistants-heading">最近客服状态</h2>
          </div>
          <StatusBadge tone={assistantsReady ? 'info' : 'warning'}>
            {assistantsReady ? '已连接' : '暂不可用'}
          </StatusBadge>
        </div>
        <p>仅展示最近 50 个客服的数据库状态；“已发布”不代表公开对话服务当前健康。</p>
        {!assistantsReady ? (
          <p role="alert">客服状态查询失败，不能据此判断没有客服。</p>
        ) : assistants.length === 0 ? (
          <p>目前没有客服记录。</p>
        ) : (
          <ol className="ops-assistant-list">
            {assistants.map((assistant) => (
              <li key={assistant.id}>
                <strong>{assistant.displayName}</strong>
                <span>{assistantStateLabel(assistant.status, assistant.activeReleaseId)}</span>
                <small>商家：{assistant.merchantName}</small>
                {assistant.activeReleaseId ? (
                  <small>正式版本：{assistant.activeReleaseId}</small>
                ) : null}
                <time dateTime={assistant.updatedAt.toISOString()}>
                  更新于{' '}
                  {assistant.updatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </time>
              </li>
            ))}
          </ol>
        )}
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
            <article className="operation-area-card" id={`${area.id}-area`} key={area.id}>
              <div aria-hidden="true" className="operation-area-card__icon">
                {area.icon}
              </div>
              <div>
                <h3>{area.label}</h3>
                <p>{area.description}</p>
              </div>
              {(area.id === 'audit' && auditReady) ||
              (area.id === 'merchants' && databaseReady && assistantsReady) ||
              (area.id === 'tasks' && jobs) ? (
                <a className="ops-area-link" href={area.href}>
                  {area.id === 'merchants'
                    ? '查看状态'
                    : area.id === 'tasks'
                      ? '查看任务'
                      : '查看记录'}
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

      <section aria-labelledby="attention-heading" className="attention-panel" id="tasks">
        <div className="section-heading">
          <div>
            <p>待处理</p>
            <h2 id="attention-heading">异常与人工处置</h2>
          </div>
          <StatusBadge tone={jobs ? (jobs.failed > 0 ? 'warning' : 'info') : 'warning'}>
            {jobs ? `${jobs.failed} 项失败` : '暂不可用'}
          </StatusBadge>
        </div>
        {!jobs ? (
          <p role="alert">任务状态查询失败，不能据此判断没有异常。</p>
        ) : jobs.recentFailed.length === 0 ? (
          <EmptyState
            description={<p>数据库当前没有失败任务；告警送达仍需独立验证。</p>}
            icon={<QueueIcon />}
            title="暂无失败任务"
          />
        ) : (
          <>
            <p>只展示最近 20 项失败任务的运行元数据；不展示任务载荷或消费者消息。</p>
            <ol className="ops-job-list">
              {jobs.recentFailed.map((job) => (
                <li key={job.id}>
                  <strong>{job.type}</strong>
                  <span>错误码：{job.lastErrorCode ?? '未记录'}</span>
                  <small>商家：{job.merchantId ?? '平台级任务'}</small>
                  <small>
                    尝试：{job.attempt}/{job.maxAttempts}
                  </small>
                  <time dateTime={job.updatedAt.toISOString()}>
                    {job.updatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                  </time>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </PageShell>
  );
}
