import { PageShell } from '@h5cs/ui';
import { loadDatabaseConfig, MySqlMarketplaceRepository } from '@h5cs/database';
import { redirect } from 'next/navigation';
import { currentMerchantIdentity, currentMerchantCsrfToken } from '../../account/merchant-actions';
import { MerchantLogoutForm } from '../../account/logout-form';

export const dynamic = 'force-dynamic';
export default async function ProductStatusPage() {
  const identity = await currentMerchantIdentity();
  if (!identity) redirect('/console/account/login');
  const database = loadDatabaseConfig();
  if (!database.configured) return <p role="alert">暂时无法核查产品状态，请稍后重试。</p>;
  const status = await new MySqlMarketplaceRepository(database.config).quotaForMerchant(
    identity.merchantId,
  );
  if (!status || status.state === 'active') redirect(`/${identity.merchantId}`);
  const label = { paused: '已暂停', revoked: '已撤销', expired: '已过期', not_started: '尚未生效' }[
    status.state
  ];
  return (
    <PageShell
      eyebrow="商家账号 / 产品状态"
      title={`AI 服务${label}`}
      description={<p>账号身份已验证，产品资格与登录身份分别管理。</p>}
    >
      <section className="merchant-account-card">
        <p role="status">
          当前产品资格{label}
          。管理写入和模型调用已受限，原商家、客服资料与固定链接仍保留。请联系运营核查；恢复资格后继续使用原资源。
        </p>
        <form action="/console/marketplace/status" method="get">
          <button type="submit">刷新核查产品状态</button>
        </form>
        <MerchantLogoutForm
          merchantId={identity.merchantId}
          csrfToken={await currentMerchantCsrfToken()}
        />
      </section>
    </PageShell>
  );
}
