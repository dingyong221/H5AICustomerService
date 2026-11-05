import { PageShell } from '@h5cs/ui';
import Link from 'next/link';
import { marketplaceFixtureEnabled, selfServicePolicy } from '@h5cs/database';
import { MarketplaceClaimForm } from './claim-form';
import { offerTerms } from './offer-copy';
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
      title="H5AI 商家 AI 客服"
      description={<p>填写真实资料，试聊确认后发布。</p>}
    >
      <section className="merchant-account-card">
        {offer ? (
          <section>
            <h2>0元领取你的AI客服</h2>
            <p>{offerTerms(offer)}。每个账号一套，重复扫码返回原后台。</p>
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
        <Link href="/console/account/login">已有账号：登录原商家后台</Link>
        <details>
          <summary>开通后怎么用？</summary>
          <ol>
            <li>填写行业、商品服务、价格优惠和特别说明</li>
            <li>补充知识，试聊核对，确认发布</li>
            <li>分享客户咨询入口，持续改善</li>
          </ol>
          <p>此入口面向商家；发布后的客户咨询二维码才用于消费者提问。不会自动收费。</p>
        </details>
      </section>
    </PageShell>
  );
}
