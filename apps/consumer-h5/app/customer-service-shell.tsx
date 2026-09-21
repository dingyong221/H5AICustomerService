import { Button, StatusBadge } from '@h5cs/ui';

function MoreIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

const serviceStates = [
  {
    detail: '知识不足时应说明无法确认，并引导补充条件或联系商家。',
    label: '资料不足',
    tone: 'warning' as const,
  },
  {
    detail: '商家暂停服务时停止发送，保留清晰说明和真实联系入口。',
    label: '客服暂停',
    tone: 'neutral' as const,
  },
  {
    detail: '网络或模型异常时保留输入，只有确认状态后才能安全重试。',
    label: '服务异常',
    tone: 'danger' as const,
  },
];

export function CustomerServiceShell() {
  return (
    <main className="consumer-page">
      <section aria-label="AI 客服咨询窗口" className="chat-shell">
        <header className="chat-header">
          <div className="assistant-identity">
            <div aria-hidden="true" className="assistant-avatar">
              AI
            </div>
            <div>
              <div className="assistant-title-row">
                <h1>商家客服</h1>
                <span className="ai-label">AI</span>
              </div>
              <p>客服配置尚未载入</p>
            </div>
          </div>
          <button aria-label="更多咨询选项" className="icon-button" disabled type="button">
            <MoreIcon />
          </button>
        </header>

        <div className="offline-notice" role="alert">
          <span aria-hidden="true" className="offline-notice__icon">
            !
          </span>
          <div>
            <strong>咨询服务尚未连接</strong>
            <p>当前是前端界面骨架，无法创建 Session 或发送消息。</p>
          </div>
        </div>

        <div aria-label="咨询消息" aria-live="polite" className="message-list" role="log">
          <p className="timeline-label">当前咨询</p>
          <article className="message-row">
            <div aria-hidden="true" className="message-avatar">
              AI
            </div>
            <div>
              <div className="message-bubble">
                <p>欢迎来到在线咨询。</p>
                <p>
                  当前页面尚未连接商家配置和会话服务，因此不会生成业务回答。服务连接后，你可以直接在这里提问。
                </p>
              </div>
              <time className="message-time">状态说明</time>
            </div>
          </article>

          <section aria-labelledby="state-preview-heading" className="state-preview">
            <div className="state-preview__heading">
              <div>
                <p>可访问状态</p>
                <h2 id="state-preview-heading">界面会明确区分以下情况</h2>
              </div>
              <StatusBadge tone="info">状态预览</StatusBadge>
            </div>
            <div className="state-preview__list">
              {serviceStates.map((state) => (
                <article key={state.label}>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                  <p>{state.detail}</p>
                </article>
              ))}
            </div>
          </section>
        </div>

        <footer className="composer-area">
          <div aria-label="快捷问题" className="quick-questions">
            <button disabled type="button">
              可以咨询什么？
            </button>
            <button disabled type="button">
              如何联系商家？
            </button>
          </div>
          <form aria-label="发送咨询消息" className="composer">
            <label className="visually-hidden" htmlFor="message-input">
              输入想咨询的问题
            </label>
            <textarea
              aria-describedby="composer-help"
              disabled
              id="message-input"
              placeholder="服务连接后可输入问题"
              rows={1}
            />
            <Button aria-label="发送消息" disabled>
              <SendIcon />
            </Button>
          </form>
          <p id="composer-help" className="composer-help">
            发送功能尚未启用。AI 回复仅供业务咨询参考。
          </p>
        </footer>
      </section>
    </main>
  );
}
