import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { loadDatabaseConfig, MySqlMerchantConversationRepository } from '@h5cs/database';
import { PageShell, StatusBadge } from '@h5cs/ui';

import { currentMerchant, currentMerchantCsrfToken } from '../../../account/merchant-actions';
import { FollowUpForm } from '../../../workspace/follow-up-form';
import { followUpLabel } from '../../../workspace/follow-up-status';

export const dynamic = 'force-dynamic';

export default async function MerchantConversationDetailPage({
  params,
}: {
  params: Promise<{ merchantId: string; sessionId: string }>;
}) {
  const { merchantId, sessionId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId) || !/^[0-9a-f]{32}$/u.test(sessionId)) notFound();
  const member = await currentMerchant(merchantId);
  if (!member) {
    const next = `/${merchantId}/conversations/${sessionId}`;
    redirect(`/console/account/login?merchant=${merchantId}&next=${encodeURIComponent(next)}`);
  }
  const database = loadDatabaseConfig();
  if (!database.configured) return <p role="alert">数据库尚未配置，咨询暂不可读。</p>;
  let detail: Awaited<ReturnType<MySqlMerchantConversationRepository['detail']>>;
  try {
    detail = await new MySqlMerchantConversationRepository(database.config).detail({
      merchantId,
      merchantUserId: member.merchantUserId,
      sessionId,
    });
  } catch {
    return <p role="alert">咨询读取失败，请稍后重试。</p>;
  }
  if (!detail) notFound();
  const csrfToken = await currentMerchantCsrfToken();
  return (
    <PageShell
      aside={<Link href={`/${merchantId}/conversations`}>返回咨询列表</Link>}
      description={<p>按原始顺序查看最近消息，处理客户问题；原始消息不可编辑。</p>}
      eyebrow="Consultation Detail"
      title={`咨询 ${sessionId.slice(0, 8)}`}
    >
      <section className="merchant-account-card merchant-conversation-panel">
        <div className="section-heading">
          <h2>{detail.conversation.assistantName}</h2>
          <StatusBadge>{followUpLabel(detail.conversation.followUpStatus)}</StatusBadge>
        </div>
        <p>关联正式版本：{detail.conversation.releaseId}</p>
        <p>会话状态：{detail.conversation.sessionStatus}</p>
        <p>
          如果回答依据需要修正，请
          <Link href={`/${merchantId}/drafts/${detail.conversation.assistantId}`}>
            编辑对应客服的资料
          </Link>
          ，确认后发布新版本。已有咨询仍保留原版本记录。
        </p>
        <FollowUpForm
          merchantId={merchantId}
          sessionId={sessionId}
          csrfToken={csrfToken}
          currentStatus={detail.conversation.followUpStatus}
        />
      </section>
      <section className="merchant-account-card merchant-conversation-panel">
        <h2>咨询消息</h2>
        {detail.olderMessagesOmitted ? <p>较早消息未在本页加载；以下是最近 100 条。</p> : null}
        {detail.messages.length === 0 ? (
          <p>当前咨询还没有消息。</p>
        ) : (
          <ol className="merchant-conversation-messages">
            {detail.messages.map((message) => (
              <li key={message.id}>
                <strong>{message.role === 'visitor' ? '消费者' : 'AI 客服'}</strong>
                <small>
                  第 {message.sequence} 条 · {message.state}
                </small>
                <p>{message.content}</p>
                {message.errorCode ? <small>失败原因：{message.errorCode}</small> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </PageShell>
  );
}
