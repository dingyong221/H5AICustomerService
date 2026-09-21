import type { Metadata } from 'next';
import Link from 'next/link';

import { PageShell, StatusBadge } from '@h5cs/ui';

import { OnboardingForm } from './onboarding-form';
import { buildOnboardingViewModel } from './onboarding-view-model';

export const metadata: Metadata = {
  description: '通过四步引导准备真实业务资料，并由平台生成可编辑的 AI 客服草稿。',
  title: '首次生成 AI 客服',
};

function LockIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M7 10V8a5 5 0 0 1 10 0v2m-11 0h12v10H6V10Zm6 4v2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

export default function OnboardingPage() {
  const authorization = 'binding_required' as const;
  const apiBaseUrl = process.env['NEXT_PUBLIC_MERCHANT_API_BASE_URL'];
  const viewModel = buildOnboardingViewModel({
    apiConnected: apiBaseUrl !== undefined,
    authorization,
  });

  return (
    <PageShell
      aside={
        <Link className="quiet-link" href="/onboarding#help">
          获取帮助
        </Link>
      }
      description={<p>四步确认真实资料后，服务端才会生成可编辑草稿；生成不等于自动发布。</p>}
      eyebrow="WorkBuddy Onboarding"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>{viewModel.connectionLabel}</strong>
            <span>默认不连接管理 API；未安全绑定时所有网络写入都会被阻止。</span>
          </div>
        </div>
      }
      title="首次生成 AI 客服"
    >
      <section aria-labelledby="identity-heading" className="binding-panel">
        <div aria-hidden="true" className="binding-panel__icon">
          <LockIcon />
        </div>
        <div>
          <div className="binding-panel__title-row">
            <h2 id="identity-heading">身份与权限</h2>
            <StatusBadge tone={viewModel.identity.tone}>{viewModel.identity.label}</StatusBadge>
          </div>
          <p>{viewModel.identity.description}</p>
        </div>
        {viewModel.identity.actionHref && viewModel.identity.actionLabel ? (
          <Link className="binding-panel__action" href={viewModel.identity.actionHref}>
            {viewModel.identity.actionLabel}
          </Link>
        ) : null}
      </section>

      <OnboardingForm
        {...(apiBaseUrl === undefined ? {} : { apiBaseUrl })}
        authorization={authorization}
      />
    </PageShell>
  );
}
