import { PageShell } from '@h5cs/ui';

import { SetupForm } from './setup-form';

export default function MerchantSetupPage() {
  return (
    <PageShell
      description={<p>请由商家负责人本人完成领取。此链接一次使用，过期后需联系平台运营。</p>}
      eyebrow="Merchant Setup"
      title="开通商家管理后台"
    >
      <section className="merchant-account-card">
        <SetupForm />
      </section>
    </PageShell>
  );
}
