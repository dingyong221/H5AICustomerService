import { PageShell } from '@h5cs/ui';
import { redirect } from 'next/navigation';

import { MerchantLoginForm } from './login-form';
import { safeMerchantReturnPath } from '../merchant-return-path';
import { currentMerchant, currentMerchantIdentity } from '../merchant-actions';

export default async function MerchantPasswordLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ merchant?: string; next?: string }>;
}) {
  const { merchant, next } = await searchParams;
  const merchantId = merchant && /^[0-9a-f]{32}$/u.test(merchant) ? merchant : undefined;
  const nextPath = merchantId ? safeMerchantReturnPath(merchantId, next) : null;
  const session = await currentMerchant(merchantId);
  if (!session && (await currentMerchantIdentity())) redirect('/console/marketplace/status');
  if (session) redirect(nextPath ?? `/${session.merchantId}`);
  return (
    <PageShell
      description={<p>使用领取时的手机号，或运营提供的 m_ 开头账号及密码登录。</p>}
      eyebrow="Merchant Account"
      title="登录商家管理后台"
    >
      <section className="merchant-account-card">
        <p>首次使用请先打开运营提供的领取链接，设置商家账号。运营账号不能用于此处登录。</p>
        <MerchantLoginForm
          {...(merchantId ? { merchantId } : {})}
          {...(nextPath ? { nextPath } : {})}
        />
      </section>
    </PageShell>
  );
}
