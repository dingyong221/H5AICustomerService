import Link from 'next/link';
import Image from 'next/image';
import { BrandMark } from '@h5cs/ui';
import { selfServicePolicy } from '@h5cs/database';
import { offerTerms } from '../marketplace/offer-copy';
export const dynamic = 'force-dynamic';

export default function ProductPage() {
  const offer = selfServicePolicy(process.env);
  const cta = offer ? '/console/marketplace' : '/console/account/login';
  return (
    <div className="product-landing">
      <section className="product-hero">
        <div className="product-hero__copy">
          <p className="product-kicker">客来答 · 商家专属 AI 客服</p>
          <h1>
            客户在问，
            <br />
            <span>你还在忙？</span>
          </h1>
          <p className="product-lead">
            价格问一遍，优惠问一遍，售后又问一遍。
            <br />
            让客来答接住这些重复咨询，把时间留给经营。
          </p>
          <p className="product-summary">
            填入你的商品、服务和经营说明，生成懂你业务的 AI
            客服。客户扫码就能问，你在一个后台持续管理。
          </p>
          <div className="product-actions">
            <a className="tenant-feature-link" href={cta}>
              {offer ? '免费开通我的 AI 客服 →' : '进入商家后台 →'}
            </a>
            <Link className="product-secondary" href="/console/account/login">
              已有账号，去登录
            </Link>
          </div>
          <p className="product-caption">无需开发 · 手机可操作 · 一个固定咨询链接</p>
        </div>
        <div className="product-demo" aria-label="客来答使用示意，内容为虚构示例">
          <div className="product-demo__header">
            <BrandMark />
            <div>
              <strong>客来答</strong>
              <small>你的商品，你的客服</small>
            </div>
            <span>示意</span>
          </div>
          <div className="product-demo__question">这款怎么选？有什么优惠？</div>
          <div className="product-demo__answer">
            我会根据商家提供的商品资料和优惠规则为你介绍。你想先了解哪款商品？
          </div>
          <div className="product-demo__question">售后规则在哪里看？</div>
          <div className="product-demo__answer">
            可以直接问我。超出已确认资料的问题，我会提示你联系商家进一步确认。
          </div>
          <div className="product-demo__footer">把反复解释，变成随时可查的回答。</div>
        </div>
      </section>
      <section className="product-section" aria-labelledby="pain-title">
        <p className="product-kicker">这些时刻，生意需要一个帮手</p>
        <h2 id="pain-title">忙着做生意，也别让咨询一直等。</h2>
        <div className="product-feature-grid">
          <article>
            <span>01 / 重复答，耗精力</span>
            <h3>同样的问题，不用一遍遍打字。</h3>
            <p>把常见问题、商品介绍和售后说明交给客服，让客户先自助了解。</p>
          </article>
          <article>
            <span>02 / 资料散，解释难</span>
            <h3>散落的业务资料，整理成回答依据。</h3>
            <p>上传 Word、PDF、PPT、Excel 等材料，核对整理后的内容，再让客服使用。</p>
          </article>
          <article>
            <span>03 / 活动变，难同步</span>
            <h3>改一次资料，沿用原来的咨询入口。</h3>
            <p>调整价格与优惠，试聊后发布新版。客户链接和二维码保持不变；必要时紧急撤回旧内容。</p>
          </article>
        </div>
      </section>
      <section className="product-section product-how" aria-labelledby="how-title">
        <h2 id="how-title">从开通到接待，按这四步来。</h2>
        <div className="product-steps">
          <article>
            <b>1</b>
            <h3>开通专属后台</h3>
            <p>手机号和密码注册；已有账号直接登录原空间。</p>
          </article>
          <article>
            <b>2</b>
            <h3>告诉它你的生意</h3>
            <p>填写行业、商品或服务、价格优惠，补充业务材料。</p>
          </article>
          <article>
            <b>3</b>
            <h3>先试聊，再发布</h3>
            <p>用客户真正会问的问题核对回答，确认后发布。</p>
          </article>
          <article>
            <b>4</b>
            <h3>把入口发给客户</h3>
            <p>分享固定咨询链接或二维码，客户打开即可提问。</p>
          </article>
        </div>
      </section>
      <section className="product-section product-activation" aria-labelledby="activation-title">
        <div>
          <p className="product-kicker">适合电商零售与商品、服务咨询</p>
          <h2 id="activation-title">给客户一个随时能打开的咨询入口。</h2>
          <p>每个商家一个 AI 客服，客户之间的咨询上下文独立。</p>
          {offer ? (
            <>
              <p className="product-caption">当前 0 元开通，不自动扣费。{offerTerms(offer)}。</p>
              <Link className="tenant-feature-link" href="/console/marketplace">
                免费开通客来答 →
              </Link>
            </>
          ) : (
            <p>自助开通暂未开放，请联系运营；已有商家可直接登录。</p>
          )}
        </div>
        {offer ? (
          <div className="product-qr">
            <Image
              src="/console/product/qr"
              alt="商家开通二维码，不是客户咨询码"
              width={152}
              height={152}
              unoptimized
            />
            <strong>扫码开通商家后台</strong>
            <a href="/console/product/qr?download=1" download="kelaida-merchant-activation.png">
              下载开通二维码
            </a>
          </div>
        ) : null}
      </section>
      <section className="product-section product-faq">
        <h2>开通前，你可能想了解</h2>
        <details>
          <summary>要写代码、安装软件吗？</summary>
          <p>不用。通过网页维护资料、试聊并发布，客户打开链接或扫码就能咨询。</p>
        </details>
        <details>
          <summary>上传的所有文件都会自动参与回答吗？</summary>
          <p>
            不会。材料需要整理、核对并保存到客服资料，再发布生效。当前商品或服务资料最多 4000
            字；扫描件 OCR、实时订单与库存同步暂不支持。
          </p>
        </details>
        <details>
          <summary>AI 能保证所有回答正确吗？</summary>
          <p>
            AI
            可能出错，价格、优惠及承诺以你核对的资料为依据。请先试聊再发布；错误或过期内容应及时修改，必要时紧急撤回。当前可展示人工联系方式，不支持实时人工转接。
          </p>
        </details>
        <details>
          <summary>商家开通码能直接发给客户吗？</summary>
          <p>请使用发布后生成的客户咨询二维码。商家开通码用于创建和登录后台，两个入口用途不同。</p>
        </details>
        <details>
          <summary>重新发布后，要重新发二维码吗？</summary>
          <p>
            不用。已有商家继续使用原客服和固定客户链接。正常更新后新会话使用新版资料；涉及错误价格或失效优惠，可使用紧急撤回处理旧版本。
          </p>
        </details>
      </section>
    </div>
  );
}
