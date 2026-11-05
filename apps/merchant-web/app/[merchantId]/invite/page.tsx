import Link from 'next/link';
import { PageShell } from '@h5cs/ui';
import { growthEnabled, loadDatabaseConfig, MySqlGrowthUsageRepository } from '@h5cs/database';
import { currentMerchant, currentMerchantCsrfToken } from '../../account/merchant-actions';
import { InviteForm } from './invite-form';
export const dynamic = 'force-dynamic';
async function readInvitation(merchantId: string, userId: string) {
  const database = loadDatabaseConfig();
  if (!database.configured) return null;
  try {
    const repo = new MySqlGrowthUsageRepository(database.config);
    return {
      code: await repo.invitation(merchantId, userId),
      stats: await repo.invitationStats(merchantId),
    };
  } catch {
    return null;
  }
}
export default async function InvitePage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params,
    session = await currentMerchant(merchantId);
  if (!session)
    return (
      <PageShell title="邀请商家">
        <p>
          请先<Link href={`/console/account/login?merchant=${merchantId}`}>登录当前商家后台</Link>。
        </p>
      </PageShell>
    );
  if (!growthEnabled())
    return (
      <PageShell title="邀请商家">
        <p>邀请功能暂未开放。</p>
      </PageShell>
    );
  const loaded = await readInvitation(merchantId, session.merchantUserId);
  if (!loaded)
    return (
      <PageShell title="邀请商家">
        <p role="alert">邀请数据暂不可用，或当前账号不是负责人。请稍后重试。</p>
      </PageShell>
    );
  const { code, stats } = loaded;
  return (
    <PageShell title="邀请商家，一起用好 AI 客服" eyebrow="客来答">
      <section className="merchant-account-card">
        <p>
          先把自己的客服用起来，再分享给有相同需要的商家。朋友开通后拥有自己的后台、客服和独立资料。
        </p>
        <InviteForm
          merchantId={merchantId}
          csrfToken={await currentMerchantCsrfToken()}
          initialUrl={code ? process.env['MERCHANT_PUBLIC_ORIGIN'] + '/console/r/' + code : null}
        />
        <p>首次生成前请先完成自己客服的发布。</p>
        <p>这是商家开通邀请入口，不能替代发给客户的咨询二维码。</p>
        <p>当前不发放邀请奖励或现金佣金，后续规则另行说明。</p>
      </section>
      <section className="merchant-account-card">
        <h2>我的邀请进度</h2>
        <p>
          近30天邀请触达 {stats.visits} 次 · 累计首次开通 {stats.opened} 家 · 完成发布{' '}
          {stats.published} 家 · 已有咨询 {stats.used} 家（含商家自测）
        </p>
        <p>
          以实际开通、发布和提问记录为准；重复开通不新增商家。访问次数是浏览器触达记录，不是实际自然人数。
        </p>
      </section>
    </PageShell>
  );
}
