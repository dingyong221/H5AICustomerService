import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlMerchantConversationRepository,
} from '@h5cs/database';
import { toAssistantId, toMerchantId } from '@h5cs/domain';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { currentMerchantCsrfToken } from '../../account/merchant-actions';
import { merchantAssistants, requireMerchant } from '../../tenant-data';
import { readImprovements } from '../../improvements/improvement-data';
import { ImprovementCreateForm } from '../../improvements/improvement-forms';
import {
  actionableImprovementCount,
  improvementReasonLabels,
  improvementStateLabels,
} from '../../improvements/improvement-model';

export const dynamic = 'force-dynamic';

export default async function MerchantImprovementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ merchantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { merchantId } = await params;
  const query = await searchParams;
  const assistantId =
    typeof query['assistant'] === 'string' && query['assistant'] ? query['assistant'] : undefined;
  const sourceSessionId = typeof query['session'] === 'string' ? query['session'] : undefined;
  const sourceMessageId = typeof query['message'] === 'string' ? query['message'] : undefined;
  if (
    [assistantId, sourceSessionId, sourceMessageId].some(
      (value) => value !== undefined && !/^[0-9a-f]{32}$/u.test(value),
    )
  )
    notFound();
  if (Boolean(sourceSessionId) !== Boolean(sourceMessageId) || (sourceMessageId && !assistantId))
    notFound();
  const member = await requireMerchant(
    merchantId,
    `/${merchantId}/improvements${assistantId ? `?assistant=${assistantId}${sourceSessionId && sourceMessageId ? `&session=${sourceSessionId}&message=${sourceMessageId}#create` : ''}` : ''}`,
  );
  const [assistants, list, csrfToken] = await Promise.all([
    merchantAssistants(merchantId),
    readImprovements(merchantId, member.merchantUserId, assistantId),
    currentMerchantCsrfToken(),
  ]);
  const chosen = assistants.find((assistant) => assistant.assistantId === assistantId);
  // A selected older assistant may not be in the recent-50 selector; repository authorization still applies.
  if (assistantId && list === null)
    return <p role="alert">改进任务暂不可读，请稍后刷新；没有把读取失败视为空列表。</p>;
  let selectedName = chosen?.displayName;
  if (assistantId && !chosen) {
    const database = loadDatabaseConfig();
    if (!database.configured) return <p role="alert">数据库暂不可用。</p>;
    const selected = await new MySqlAssistantLifecycleRepository(
      database.config,
    ).findManagementSnapshot(toMerchantId(merchantId), toAssistantId(assistantId));
    if (!selected) notFound();
    selectedName = selected.displayName;
  }
  let source: { sessionId: string; messageId: string; question: string } | undefined;
  if (sourceSessionId && sourceMessageId && assistantId) {
    const database = loadDatabaseConfig();
    if (!database.configured) return <p role="alert">数据库暂不可用。</p>;
    const detail = await new MySqlMerchantConversationRepository(database.config).detail({
      merchantId,
      merchantUserId: member.merchantUserId,
      sessionId: sourceSessionId,
    });
    const message = detail?.messages.find(
      (entry) => entry.id === sourceMessageId && entry.role === 'visitor',
    );
    if (!detail || detail.conversation.assistantId !== assistantId || !message) notFound();
    source = { sessionId: sourceSessionId, messageId: sourceMessageId, question: message.content };
  }
  const options: { id: string; displayName: string }[] = assistants.map((assistant) => ({
    id: assistant.assistantId,
    displayName: assistant.displayName,
  }));
  if (assistantId && !chosen)
    options.push({
      id: assistantId,
      displayName: selectedName ?? `客服 ${assistantId.slice(0, 8)}`,
    });
  const selected = assistantId ?? options[0]?.id ?? '';
  return (
    <PageShell
      title="问题与改进"
      eyebrow="持续改善客服"
      aside={<Link href={`/${merchantId}`}>返回工作台</Link>}
      description={<p>发现问题 → 补充真实知识 → 复测并人工判定 → 确认资料 → 发布更新。</p>}
    >
      <section className="merchant-account-card assistant-detail-card">
        <h2>{selectedName ? `${selectedName}的改进任务` : '让客服越用越好'}</h2>
        <p>
          这里记录你主动标记的待改进问题，不是 AI
          自动推定的解决率。咨询“待处理”仅代表跟进状态，不代表回答错误。
        </p>
        <form className="improvement-filter" method="get" action={`/${merchantId}/improvements`}>
          <label>
            按客服查看
            <select name="assistant" defaultValue={assistantId ?? ''}>
              <option value="">全部客服</option>
              {options.map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistant.displayName}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">查看任务</button>
        </form>
        {list ? (
          <>
            <p>
              待推进 <strong>{actionableImprovementCount(list.counts)}</strong> 项，共 {list.total}{' '}
              项。
            </p>
            <ul className="improvement-counts" aria-label="改进任务状态数量">
              {Object.entries(list.counts).map(([key, count]) => (
                <li key={key}>
                  {improvementStateLabels[key as keyof typeof improvementStateLabels]}{' '}
                  <strong>{count}</strong>
                </li>
              ))}
            </ul>
            {list.items.length ? (
              <ol className="improvement-list">
                {list.items.map((task) => (
                  <li key={task.id}>
                    <StatusBadge tone={task.state === 'published' ? 'info' : 'warning'}>
                      {improvementStateLabels[task.state]}
                    </StatusBadge>
                    <h3>
                      <Link
                        href={`/${merchantId}/improvements/${task.id}?assistant=${task.assistantId}`}
                      >
                        {task.question}
                      </Link>
                    </h3>
                    <p>
                      {improvementReasonLabels[task.reason]} ·{' '}
                      {options.find((assistant) => assistant.id === task.assistantId)
                        ?.displayName ?? `客服 ${task.assistantId.slice(0, 8)}`}
                    </p>
                    <small>
                      任务版本 {task.version} · 更新于{' '}
                      {task.updatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <p>暂时没有改进任务。可在下方新增场景，或到咨询详情点击“改进这条回答”。</p>
            )}
            {list.truncated ? (
              <p>
                列表展示最近更新的 50 项，数量统计包含当前筛选范围的全部任务。可按客服缩小范围。
              </p>
            ) : null}
          </>
        ) : (
          <p role="alert">改进任务暂不可读，请稍后重试；未将读取失败显示为 0。</p>
        )}
        <div className="tenant-feature-grid">
          <Link href={`/${merchantId}/conversations`}>从真实咨询发现问题</Link>
          <Link href={`/${merchantId}/help#improvements`}>查看改进操作帮助</Link>
        </div>
      </section>
      <section className="merchant-account-card assistant-detail-card" id="create">
        <h2>{source ? '改进这条真实咨询' : '新增一个场景'}</h2>
        <p>
          可以记录“优惠能否叠加”“偏远地区运费”“不知道的商品”“投诉与找人工”等问题；期望答案由商家核对，不凭空生成。
        </p>
        {source ? (
          <p>
            <Link href={`/${merchantId}/conversations/${source.sessionId}`}>查看来源咨询</Link> ·
            原始消费者消息会由服务器再次核对。
          </p>
        ) : null}
        <ImprovementCreateForm
          key={`${selected}:${source?.messageId ?? 'manual'}`}
          merchantId={merchantId}
          csrfToken={csrfToken}
          requestKey={randomUUID()}
          assistants={options}
          assistantId={selected}
          source={source}
        />
        {assistants.length >= 50 ? (
          <p>客服选择器显示最近 50 个客服；更早的客服请从对应客服详情进入改进模块。</p>
        ) : null}
      </section>
    </PageShell>
  );
}
