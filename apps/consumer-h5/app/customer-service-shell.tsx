import { OnlineCustomerService } from './online-customer-service';
import type { PublicAssistantLoadResult } from './public-api-client';

interface CustomerServiceShellProps {
  apiBaseUrl?: string | undefined;
  publicSlug?: string | undefined;
  result: PublicAssistantLoadResult;
}

function unavailableCopy(result: PublicAssistantLoadResult): {
  detail: string;
  heading: string;
} {
  if (
    result.status === 'unavailable' &&
    (result.reason === 'api_unavailable' ||
      result.reason === 'invalid_response' ||
      result.reason === 'unsafe_configuration')
  ) {
    return {
      detail: '我们无法安全确认客服当前状态，请稍后刷新页面重试。',
      heading: '咨询服务暂时不可用',
    };
  }
  return {
    detail: '此客服当前未开放咨询，请通过商家公布的其他方式联系。',
    heading: '咨询服务未开放',
  };
}

export function CustomerServiceShell({
  apiBaseUrl,
  publicSlug,
  result,
}: CustomerServiceShellProps) {
  if (result.status === 'online' && apiBaseUrl !== undefined && publicSlug !== undefined) {
    return (
      <OnlineCustomerService
        apiBaseUrl={apiBaseUrl}
        publicSlug={publicSlug}
        snapshot={result.snapshot}
      />
    );
  }

  const copy = unavailableCopy(result);
  return (
    <main className="consumer-page">
      <section aria-label="客服咨询状态" className="chat-shell chat-shell--unavailable">
        <header className="chat-header">
          <div className="assistant-identity">
            <div aria-hidden="true" className="assistant-avatar assistant-avatar--muted">
              AI
            </div>
            <div>
              <div className="assistant-title-row">
                <h1>商家客服</h1>
                <span className="ai-label">AI</span>
              </div>
              <p>状态未确认</p>
            </div>
          </div>
        </header>
        <div className="unavailable-panel" role="alert">
          <span aria-hidden="true" className="unavailable-panel__icon">
            !
          </span>
          <h2>{copy.heading}</h2>
          <p>{copy.detail}</p>
          <p className="unavailable-panel__safety">
            本页面不会根据链接参数或本地记录开启会话，也不会生成模拟回复。
          </p>
        </div>
        <footer className="composer-area">
          <form aria-label="发送咨询消息" className="composer">
            <label className="visually-hidden" htmlFor="message-input">
              咨询服务不可用
            </label>
            <textarea disabled id="message-input" placeholder="当前无法发送消息" rows={1} />
            <button aria-label="发送消息" className="send-button" disabled type="button">
              发送
            </button>
          </form>
        </footer>
      </section>
    </main>
  );
}
