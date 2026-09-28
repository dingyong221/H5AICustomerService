import { PageShell } from '@h5cs/ui';

import { MerchantLoginForm } from './login-form';
import { safeMerchantReturnPath } from '../merchant-return-path';

export default async function MerchantPasswordLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ merchant?: string; next?: string }>;
}) {
  const { merchant, next } = await searchParams;
  const merchantId = merchant && /^[0-9a-f]{32}$/u.test(merchant) ? merchant : undefined;
  const nextPath = merchantId ? safeMerchantReturnPath(merchantId, next) : null;
  return (
    <PageShell
      description={<p>使用领取后台时设置的平台账号登录。管理权限以服务端成员关系为准。</p>}
      eyebrow="Merchant Account"
      title="登录商家管理后台"
    >
      <section className="merchant-account-card">
        <MerchantLoginForm
          {...(merchantId ? { merchantId } : {})}
          {...(nextPath ? { nextPath } : {})}
        />
      </section>
    </PageShell>
  );
}
