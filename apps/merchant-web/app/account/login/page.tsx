import { PageShell } from '@h5cs/ui';

import { MerchantLoginForm } from './login-form';

export default async function MerchantPasswordLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ merchant?: string }>;
}) {
  const { merchant } = await searchParams;
  const merchantId = merchant && /^[0-9a-f]{32}$/u.test(merchant) ? merchant : undefined;
  return (
    <PageShell
      description={<p>使用领取后台时设置的平台账号登录。管理权限以服务端成员关系为准。</p>}
      eyebrow="Merchant Account"
      title="登录商家管理后台"
    >
      <section className="merchant-account-card">
        <MerchantLoginForm {...(merchantId ? { merchantId } : {})} />
      </section>
    </PageShell>
  );
}
