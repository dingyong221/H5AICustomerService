import type { Metadata } from 'next';

import { PageShell, StatusBadge } from '@h5cs/ui';

import { WorkBuddyAuthorizationStatePanel } from '../authorization-state-panel';
import { buildWorkBuddyConnectionViewModel } from '../connection-view-model';
import { loadTrustedWorkBuddyAuthorizationSnapshot } from '../trusted-server-state';

export const metadata: Metadata = {
  description: '由可信服务端状态驱动的WorkBuddy身份绑定与商家确认页面。',
  title: 'WorkBuddy 安全绑定',
};

type SearchParameters = Record<string, string | readonly string[] | undefined>;

export default async function WorkBuddyBindingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParameters>;
}) {
  const untrustedCallbackPresent = Object.keys(await searchParams).length > 0;
  const trustedServerSnapshot = await loadTrustedWorkBuddyAuthorizationSnapshot();
  const connection = buildWorkBuddyConnectionViewModel({
    applicationOrigin: process.env['MERCHANT_WEB_ORIGIN'],
    trustedServerSnapshot,
    untrustedCallbackPresent,
  });

  return (
    <PageShell
      aside={<StatusBadge tone={connection.tone}>{connection.label}</StatusBadge>}
      description={<p>身份绑定与商家候选只能来自服务端会话和权威Membership。</p>}
      eyebrow="Secure Binding"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>{connection.label}</strong>
            <span>{connection.description}</span>
          </div>
        </div>
      }
      title="绑定身份并确认授权商家"
    >
      <section className="login-gate">
        <div>
          <p className="panel__eyebrow">0 / 1 / 多商家</p>
          <h2>商家数量由服务端计算</h2>
          <p>
            0个商家不能继续；1个商家仍需明确consent；多个商家不默认选择。页面不会读取query中的商家、账号、code或state作为授权事实。
          </p>
        </div>
      </section>
      <WorkBuddyAuthorizationStatePanel backHref="/login" model={connection} />
    </PageShell>
  );
}
