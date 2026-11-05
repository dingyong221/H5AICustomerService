import Link from 'next/link';
import type { AssistantManagementSnapshot } from '@h5cs/domain';
import { merchantPath } from '../tenant-paths';
import type { PublicationGovernance } from './governance-model';
import { setupProgress } from './setup-progress';

export function SetupProgressPanel({
  merchantId,
  assistant,
  governance,
}: {
  merchantId: string;
  assistant: AssistantManagementSnapshot | null;
  governance: PublicationGovernance | null;
}) {
  const progress = setupProgress(assistant, governance);
  const path = (section: 'drafts' | 'knowledge' | 'preview' | 'publish') =>
    assistant
      ? merchantPath(merchantId, section, assistant.assistantId)
      : merchantPath(merchantId, 'drafts');
  return (
    <section
      className="merchant-account-card setup-progress"
      aria-labelledby="setup-progress-heading"
    >
      <h2 id="setup-progress-heading">{assistant ? '客服配置进度' : '开始使用你的AI客服'}</h2>
      <p role="status" className="setup-progress__notice">
        {progress.notice}
      </p>
      <ol className="setup-progress__steps">
        {progress.steps.map((step, index) => (
          <li key={step.section}>
            <span className="setup-progress__number" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <strong>{step.title}</strong>
              <p className="setup-progress__state">{step.status}</p>
              <p>{step.detail}</p>
              {assistant || index === 0 ? (
                <Link href={path(step.section)}>查看{step.title} →</Link>
              ) : (
                <span>先完成基础资料</span>
              )}
            </div>
          </li>
        ))}
      </ol>
      {assistant && progress.reminders.length ? (
        <details className="setup-progress__reminders">
          <summary>资料核对提醒（{progress.reminders.length}项）</summary>
          <p>这是文字规则提醒，不是完整性评分，不会替你确认价格或优惠。</p>
          <ul>
            {progress.reminders.map((item) => (
              <li key={item.code}>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
              </li>
            ))}
          </ul>
          <Link href={path('drafts')}>返回基础资料核对 →</Link>
        </details>
      ) : null}
      <div className="setup-progress__next">
        <h3>下一步：{progress.next.label}</h3>
        <p>{progress.next.detail}</p>
        <Link
          className="tenant-feature-link"
          href={path(progress.next.section as 'drafts' | 'knowledge' | 'preview' | 'publish')}
        >
          {progress.next.label} →
        </Link>
      </div>
      <p className="setup-progress__hint">
        发给客户的是发布分享页中的客户咨询链接和二维码；不要分享商家后台或领取入口。
      </p>
    </section>
  );
}
