import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { loadDatabaseConfig, MySqlMerchantConversationRepository } from '@h5cs/database';
import { PageShell, StatusBadge } from '@h5cs/ui';

import { currentMerchant } from '../../account/merchant-actions';
import { followUpLabel, validFollowUpStatus } from '../../workspace/follow-up-status';

export const dynamic = 'force-dynamic';

export default async function MerchantConversationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ merchantId: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}) {
  const { merchantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) notFound();
  const member = await currentMerchant(merchantId);
  if (!member) {
    redirect(
      `/console/account/login?merchant=${merchantId}&next=${encodeURIComponent(`/${merchantId}/conversations`)}`,
    );
  }
  const query = await searchParams;
  const filter = query.status === undefined ? null : validFollowUpStatus(query.status);
  if (query.status !== undefined && !filter) notFound();
  const database = loadDatabaseConfig();
  let result: Awaited<ReturnType<MySqlMerchantConversationRepository['list']>> | null = null;
  if (database.configured) {
    try {
      result = await new MySqlMerchantConversationRepository(database.config).list({
        merchantId,
        merchantUserId: member.merchantUserId,
        cursor: query.cursor ?? null,
        followUpStatus: filter,
      });
    } catch {
      result = null;
    }
  }
  const nextQuery = new URLSearchParams();
  if (filter) nextQuery.set('status', filter);
  if (result?.nextCursor) nextQuery.set('cursor', result.nextCursor);
  return (
    <PageShell
      aside={<Link href={`/${merchantId}`}>返回工作台</Link>}
      description={<p>查看消费者咨询，按需人工跟进。此处不允许修改消费者原始消息。</p>}
      eyebrow="Merchant Consultations"
      title="咨询管理"
    >
      <p>
        <Link href={`/${merchantId}/help#conversations`}>查看咨询跟进帮助</Link>
      </p>
      <section className="merchant-account-card merchant-conversation-panel">
        <div className="section-heading">
          <h2>最近咨询</h2>
          <StatusBadge tone={result ? 'info' : 'warning'}>
            {result ? '已连接' : '暂不可用'}
          </StatusBadge>
        </div>
        <nav aria-label="筛选跟进状态" className="merchant-conversation-filters">
          <Link href={`/${merchantId}/conversations`}>全部</Link>
          <Link href={`/${merchantId}/conversations?status=pending`}>待处理</Link>
          <Link href={`/${merchantId}/conversations?status=in_progress`}>处理中</Link>
          <Link href={`/${merchantId}/conversations?status=resolved`}>已处理</Link>
        </nav>
        {!result ? (
          <p role="alert">咨询暂不可读取；不能据此判断没有客户咨询。</p>
        ) : result.items.length === 0 ? (
          <p>当前筛选下没有咨询。</p>
        ) : (
          <ol className="merchant-conversation-list">
            {result.items.map((item) => (
              <li key={item.sessionId}>
                <Link href={`/${merchantId}/conversations/${item.sessionId}`}>
                  {item.assistantName} · {item.sessionId.slice(0, 8)}
                </Link>
                <span>{followUpLabel(item.followUpStatus)}</span>
                <small>
                  最近活动：
                  {item.lastActivityAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </small>
              </li>
            ))}
          </ol>
        )}
        {result?.nextCursor ? (
          <Link href={`/${merchantId}/conversations?${nextQuery.toString()}`}>下一页咨询</Link>
        ) : null}
      </section>
    </PageShell>
  );
}
