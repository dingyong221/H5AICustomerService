import { Button, EmptyState, PageShell, StatusBadge } from '@h5cs/ui';

function ArrowIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="m9 18 6-6-6-6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M4.5 6.5h15v11h-15v-11Zm0 7h4l1.5 2h4l1.5-2h4"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

const setupItems = ['商家与客服名称', '业务范围与回答边界', '欢迎语与无法回答策略'];

export default function MerchantDashboardPage() {
  return (
    <PageShell
      aside={<Button disabled>发布客服</Button>}
      description={<p>完成客服资料、知识和测试后再发布。当前仅展示工程骨架，不会提交任何配置。</p>}
      eyebrow="Merchant Console"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>尚未连接 API</strong>
            <span>数据、登录和发布能力均未启用；页面不会伪造保存或发布结果。</span>
          </div>
        </div>
      }
      title="把真实业务资料，变成可控的 AI 客服"
    >
      <div id="overview" className="dashboard-grid">
        <section aria-labelledby="service-heading" className="hero-card">
          <div className="hero-card__topline">
            <StatusBadge tone="warning">待连接</StatusBadge>
            <span>客服状态</span>
          </div>
          <h2 id="service-heading">客服配置尚未载入</h2>
          <p>连接管理 API 后，这里将展示草稿完整度、线上版本和固定 H5 入口。</p>
          <div className="hero-card__actions">
            <a className="text-action" href="#draft">
              查看配置入口
              <ArrowIcon />
            </a>
            <a className="text-action text-action--muted" href="#release">
              查看发布检查
              <ArrowIcon />
            </a>
          </div>
          <div aria-hidden="true" className="hero-card__orb hero-card__orb--one" />
          <div aria-hidden="true" className="hero-card__orb hero-card__orb--two" />
        </section>

        <section aria-label="工作台概况" className="metric-strip">
          <article>
            <span>待处理咨询</span>
            <strong aria-label="尚未获取">—</strong>
            <small>等待咨询 API</small>
          </article>
          <article>
            <span>可用知识</span>
            <strong aria-label="尚未获取">—</strong>
            <small>等待知识 API</small>
          </article>
          <article>
            <span>本期用量</span>
            <strong aria-label="尚未获取">—</strong>
            <small>等待用量 API</small>
          </article>
        </section>
      </div>

      <div className="workspace-grid">
        <section aria-labelledby="draft-heading" className="panel" id="draft">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">01 · 客服草稿</p>
              <h2 id="draft-heading">先把接待边界说清楚</h2>
            </div>
            <StatusBadge>未载入</StatusBadge>
          </div>
          <p className="panel__intro">
            草稿只在服务端确认保存后生效。当前没有后端连接，因此所有字段保持只读占位。
          </p>
          <ul className="setup-list">
            {setupItems.map((item, index) => (
              <li key={item}>
                <span aria-hidden="true" className="setup-list__number">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span>{item}</span>
                <small>待获取</small>
              </li>
            ))}
          </ul>
          <Button disabled variant="secondary">
            编辑客服草稿
          </Button>
        </section>

        <section aria-labelledby="knowledge-heading" className="panel" id="knowledge">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">02 · 知识库</p>
              <h2 id="knowledge-heading">只用经过确认的资料回答</h2>
            </div>
            <StatusBadge tone="info">等待 API</StatusBadge>
          </div>
          <EmptyState
            action={
              <Button disabled variant="secondary">
                添加知识
              </Button>
            }
            className="compact-empty-state"
            description={<p>连接后可维护 FAQ、文本与可提取文字的 PDF，并查看真实处理状态。</p>}
            icon={<InboxIcon />}
            title="尚未读取知识库"
          />
        </section>

        <section aria-labelledby="release-heading" className="panel panel--wide" id="release">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">03 · 测试与发布</p>
              <h2 id="release-heading">只有服务端确认成功，才算发布</h2>
            </div>
            <StatusBadge tone="warning">不可发布</StatusBadge>
          </div>
          <div className="release-steps">
            <article>
              <span aria-hidden="true">1</span>
              <div>
                <strong>发布检查</strong>
                <p>必填项、知识可用状态和版本差异等待 API 返回。</p>
              </div>
            </article>
            <article>
              <span aria-hidden="true">2</span>
              <div>
                <strong>隔离试聊</strong>
                <p>测试会话尚未启用，不会展示模拟 AI 回复。</p>
              </div>
            </article>
            <article>
              <span aria-hidden="true">3</span>
              <div>
                <strong>确认发布</strong>
                <p>服务端 operation 成功后才会提供固定链接与二维码。</p>
              </div>
            </article>
          </div>
        </section>

        <section
          aria-labelledby="conversation-heading"
          className="panel panel--wide"
          id="conversations"
        >
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">04 · 咨询管理</p>
              <h2 id="conversation-heading">需要跟进的咨询会出现在这里</h2>
            </div>
          </div>
          <EmptyState
            className="compact-empty-state compact-empty-state--row"
            description={<p>尚未连接会话 API，当前无法确认是否存在消费者咨询或需求。</p>}
            icon={<InboxIcon />}
            title="没有可展示的数据"
          />
        </section>
      </div>
    </PageShell>
  );
}
