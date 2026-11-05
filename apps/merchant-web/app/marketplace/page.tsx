import { PageShell } from '@h5cs/ui';
import Link from 'next/link';
import { marketplaceFixtureEnabled, selfServicePolicy } from '@h5cs/database';
import { MarketplaceClaimForm } from './claim-form';
import { currentMerchant, currentMerchantIdentity } from '../account/merchant-actions';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
export default async function MarketplacePage() {
  const existing = await currentMerchant();
  if (existing) redirect(`/${existing.merchantId}`);
  if (await currentMerchantIdentity()) redirect('/console/marketplace/status');
  const fixture = marketplaceFixtureEnabled(process.env);
  const offer = selfServicePolicy(process.env);
  return (
    <PageShell
      eyebrow="商家自助开通"
      title="免费开通客来答"
      description={<p>给生意配一个懂业务的 AI 客服。</p>}
    >
      <section className="merchant-account-card">
        {offer ? (
          <section>
            <MarketplaceClaimForm offer={{ days: offer.days, modelCalls: offer.modelCalls }} />
          </section>
        ) : fixture ? (
          <section>
            <h2>本地合成测试 · 非真实 AI 超市</h2>
            <p>
              测试适配器只在专用本地环境开放，不验证自然人身份。新草稿未发布，模型预算默认0，不会自动调用千问。
            </p>
            <MarketplaceClaimForm />
          </section>
        ) : (
          <p role="status">
            商家自助领取暂未开放。已有账号可以登录；首次使用可联系运营获取领取链接。
          </p>
        )}
        <p>
          <Link href="/console/account/login">已有账号？直接登录 →</Link>
        </p>
      </section>
    </PageShell>
  );
}
