import Link from 'next/link';
import { PageShell } from '@h5cs/ui';
import Image from 'next/image';
import { selfServicePolicy } from '@h5cs/database';
import { offerTerms } from '../marketplace/offer-copy';
export const dynamic = 'force-dynamic';

export default function ProductPage() {
  const offer = selfServicePolicy(process.env);
  return (
    <PageShell
      title="H5 AI客服"
      eyebrow="商家自助服务"
      description={<p>把商品和服务资料整理成专属客服，通过固定链接和二维码接待客户。</p>}
    >
      <section className="merchant-account-card">
        <h2>适合哪些商家？</h2>
        <p>
          电商零售及有明确商品、服务和售后说明的商家。每个商家管理一个AI客服，客户分别保留自己的咨询上下文。
        </p>
        <h2>你可以做什么？</h2>
        <ul>
          <li>填写业务资料，使用资料填写助手整理表达。</li>
          <li>上传PDF、Word、PPT、Excel及文本材料，核对整理稿并保存。</li>
          <li>用实际问题试聊，判定合格后发布，获取固定的客户咨询链接和二维码。</li>
          <li>查看咨询、修订资料、重新发布并持续改进，客户链接保持不变。</li>
        </ul>
        <p>
          上传的全部附件不会自动参与回答；当前商品或服务资料最多4000字，以核对保存并发布的内容为准。暂不支持扫描件OCR、实时订单库存同步或实时人工转接。
        </p>
      </section>
      <section className="merchant-account-card" aria-labelledby="product-claim-heading">
        <h2 id="product-claim-heading">如何开通？</h2>
        <ol>
          <li>取得有效开通资格或运营提供的一次性领取链接。</li>
          <li>设置手机号和密码，或登录已有商家账号。</li>
          <li>进入原商家后台，按基础资料、知识补充、效果试聊、发布分享完成配置。</li>
          <li>把发布页的客户咨询链接和二维码分享给客户。</li>
        </ol>
        {offer ? (
          <>
            <p>0元领取，{offerTerms(offer)}；重复领取不重置额度和期限，不自动收费。</p>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- A fresh document resets the long marketing-page scroll before mobile registration. */}
            <a className="tenant-feature-link" href="/console/marketplace">
              免费领取并开通 →
            </a>
            <p>手机扫码进入本产品页：</p>
            <Image
              src="/console/product/qr"
              alt="商家开通二维码，用于商家领取，不是客户咨询码"
              width={176}
              height={176}
              unoptimized
            />
            <p>
              <a href="/console/product/qr?download=1" download="h5ai-merchant-activation.png">
                下载商家开通二维码
              </a>
            </p>
            <p>商家开通链接：{offer.origin}/console/product</p>
          </>
        ) : (
          <p role="status">
            商家自助免费领取暂未开放。首次使用可联系运营取得一次性领取链接，已有商家可登录原后台。
          </p>
        )}
        <Link className="tenant-feature-link" href="/console/account/login">
          已有账号，登录商家后台 →
        </Link>
        <p>
          服务期限和AI次数以上方当前规则为准。后续规则如有调整会另行说明；资料和固定客户链接保留，不会自动扣费。
        </p>
      </section>
      <section className="merchant-account-card">
        <h2>常见问题</h2>
        <details>
          <summary>商家开通二维码和客户咨询二维码一样吗？</summary>
          <p>
            不同。开通入口用于商家领取和管理；发布后的客户咨询二维码才用于客户提问。不要把后台地址发给客户。
          </p>
        </details>
        <details>
          <summary>已经开通过，还需要重新创建吗？</summary>
          <p>不需要。用原账号登录后进入AI客服管理，所有修改都基于原客服和固定客户链接。</p>
        </details>
        <details>
          <summary>AI会自动承诺价格和优惠吗？</summary>
          <p>
            价格、优惠、适用条件及售后承诺由商家提供并核对；模型可能出错，应先试聊再发布，发现错误及时修订或紧急撤回。
          </p>
        </details>
      </section>
    </PageShell>
  );
}
