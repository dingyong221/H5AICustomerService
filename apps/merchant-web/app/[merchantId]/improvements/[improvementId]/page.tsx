import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  loadDatabaseConfig,
  MySqlAssistantImprovementRepository,
  MySqlAssistantLifecycleRepository,
} from '@h5cs/database';
import {
  applyImprovementFaq,
  ImprovementConflictError,
  toAssistantId,
  toMerchantId,
} from '@h5cs/domain';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { currentMerchantCsrfToken } from '../../../account/merchant-actions';
import { requireMerchant } from '../../../tenant-data';
import {
  ImprovementApplyForm,
  ImprovementEditForm,
  ImprovementEvaluateForm,
  ImprovementReviewForm,
} from '../../../improvements/improvement-forms';
import {
  evaluationIsCurrent,
  improvementReasonLabels,
  improvementStateLabels,
} from '../../../improvements/improvement-model';

export const dynamic = 'force-dynamic';

export default async function ImprovementDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ merchantId: string; improvementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { merchantId, improvementId } = await params;
  const query = await searchParams;
  const assistantId = query['assistant'];
  if (
    !/^[0-9a-f]{32}$/u.test(improvementId) ||
    typeof assistantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(assistantId)
  )
    notFound();
  const member = await requireMerchant(
    merchantId,
    `/${merchantId}/improvements/${improvementId}?assistant=${assistantId}`,
  );
  const database = loadDatabaseConfig();
  if (!database.configured) return <p role="alert">数据库暂不可用，任务尚未加载。</p>;
  let detail;
  let assistant;
  try {
    [detail, assistant] = await Promise.all([
      new MySqlAssistantImprovementRepository(database.config).detail({
        merchantId,
        merchantUserId: member.merchantUserId,
        assistantId,
        improvementId,
      }),
      new MySqlAssistantLifecycleRepository(database.config).findManagementSnapshot(
        toMerchantId(merchantId),
        toAssistantId(assistantId),
      ),
    ]);
  } catch {
    return <p role="alert">改进任务读取失败，请稍后刷新；未改动任何资料。</p>;
  }
  if (!detail || !assistant) notFound();
  if (detail.currentDraftRevision !== assistant.draftRevision)
    return <p role="status">草稿刚刚发生变化，请刷新加载一致的任务与资料后再操作。</p>;
  const task = detail.improvement;
  const csrfToken = await currentMerchantCsrfToken();
  const identity = {
    merchantId,
    assistantId,
    improvementId,
    csrfToken,
    version: task.version,
    draftRevision: detail.currentDraftRevision,
  };
  let patch: { materials: string; block: string } | null = null;
  let patchError: string | null = null;
  if (task.expectedAnswer.trim()) {
    try {
      patch = applyImprovementFaq({
        materials: assistant.draft.materialsSummary,
        improvementId,
        question: task.question,
        expectedAnswer: task.expectedAnswer,
        previousBlock: task.appliedBlock,
      });
    } catch (error) {
      patchError =
        error instanceof ImprovementConflictError && error.code === 'too_long'
          ? '合并后的商品或服务资料超过 4000 字，不能直接应用。请先整理草稿，保留真实事实后再试。'
          : '已有 FAQ 区块被手动调整或内容不符合要求。请先人工核对草稿，不会自动覆盖。';
    }
  }
  const latest = detail.runs[0];
  const promptTemplateVersion = process.env['PUBLISH_PROMPT_TEMPLATE_VERSION'];
  const modelPolicyVersion = process.env['PUBLISH_MODEL_POLICY_VERSION'];
  const current = {
    version: task.version,
    draftRevision: detail.currentDraftRevision,
    factsHash: detail.currentFactsHash,
    ...(promptTemplateVersion && modelPolicyVersion
      ? { promptTemplateVersion, modelPolicyVersion }
      : {}),
  };
  const canEvaluate = Boolean(
    task.appliedBlock &&
    task.appliedDraftRevision !== null &&
    task.expectedAnswer.trim() &&
    assistant.draft.materialsSummary.includes(task.appliedBlock) &&
    assistant.status !== 'paused',
  );
  return (
    <PageShell
      title="改进这条回答"
      eyebrow="问题与改进"
      aside={
        <Link href={`/${merchantId}/improvements?assistant=${assistantId}`}>返回改进任务</Link>
      }
      description={
        <p>任何自动生成或复测都不能代替你确认真实业务事实。草稿变更后，旧的通过判定会过期。</p>
      }
    >
      <section className="merchant-account-card assistant-detail-card improvement-detail">
        <div className="section-heading">
          <h2>{assistant.displayName}</h2>
          <StatusBadge tone={task.state === 'published' ? 'info' : 'warning'}>
            {improvementStateLabels[task.state]}
          </StatusBadge>
        </div>
        <p>
          任务版本 {task.version} · 当前草稿修订 {detail.currentDraftRevision} ·{' '}
          {improvementReasonLabels[task.reason]}
        </p>
        <h3>原始问题</h3>
        <p className="improvement-answer">{task.question}</p>
        <h3>原始 AI 回答</h3>
        <p className="improvement-answer">
          {task.originalAnswer ??
            (task.sourceMessageId
              ? '原咨询没有已完成的 AI 回答（可能尚未回答或调用失败）。'
              : '手工场景，无原始消费者回答。')}
        </p>
        {task.reason === 'human_help' || task.reason === 'complaint' ? (
          <p className="improvement-error">
            本任务只改善回复依据，不代表投诉已解决或已接通人工。请另外使用真实联系渠道处理消费者问题，并更新原咨询的人工跟进状态。
          </p>
        ) : null}
        {task.sourceSessionId ? (
          <p>
            <Link href={`/${merchantId}/conversations/${task.sourceSessionId}`}>查看来源咨询</Link>{' '}
            · 当时的发布版本：{task.sourceReleaseId ?? '无'}
          </p>
        ) : null}
        {task.publishedReleaseId ? (
          <p>
            此任务曾关联发布版本：{task.publishedReleaseId}。
            {assistant.activeReleaseId === task.publishedReleaseId
              ? '该版本当前在线。'
              : '当前线上版本已不同，不能用旧的发布记录保证当前回答。'}
          </p>
        ) : null}
        <div className="tenant-feature-grid">
          <Link href={`/${merchantId}/drafts/${assistantId}`}>查看当前草稿</Link>
          <Link href={`/${merchantId}/help#improvements`}>查看操作帮助</Link>
        </div>
      </section>
      <section className="merchant-account-card assistant-detail-card">
        <h2>1. 写清期望答案</h2>
        <ImprovementEditForm
          key={task.version}
          {...identity}
          requestKey={randomUUID()}
          edit={{
            question: task.question,
            expectedAnswer: task.expectedAnswer,
            reason: task.reason,
            notes: task.notes,
          }}
          fromMessage={Boolean(task.sourceMessageId)}
        />
      </section>
      <section className="merchant-account-card assistant-detail-card">
        <h2>2. 核对修正内容，写入未发布草稿</h2>
        <p>
          本轮通过 FAQ
          修正回答依据，不会代你查订单、退款或处理投诉。这些问题需在期望答案里给出真实的人工处理渠道。
        </p>
        <p>下方使用的是已保存的期望答案。如果你刚在上方编辑，请先保存任务再核对。</p>
        {patch ? (
          <>
            {task.appliedBlock ? (
              <details>
                <summary>查看将被替换的旧 FAQ 区块</summary>
                <pre className="improvement-patch">{task.appliedBlock}</pre>
              </details>
            ) : (
              <p>此次将追加一个 FAQ 区块，其他资料保留。</p>
            )}
            <pre className="improvement-patch" aria-label="拟写入草稿的 FAQ">
              {patch.block}
            </pre>
            <p>
              合并后商品或服务资料 {patch.materials.length} / 4000
              字；请检查与已有价格和优惠说明是否冲突。
            </p>
          </>
        ) : (
          <p role={patchError ? 'alert' : 'status'}>
            {patchError ?? '请先保存真实有效的期望答案，之后才能应用。'}
          </p>
        )}
        <ImprovementApplyForm
          {...identity}
          requestKey={randomUUID()}
          available={Boolean(patch) && assistant.status !== 'paused'}
        />
      </section>
      <section className="merchant-account-card assistant-detail-card">
        <h2>3. 复测同一个问题</h2>
        {!canEvaluate ? <p>请先把已核对的答案应用到当前草稿；客服暂停时不能发起复测。</p> : null}
        {latest?.state === 'pending' ? (
          <p role="status">
            最近一次复测仍在记录中。请稍后刷新查看；不要重复点击。长时间未完成时，可稍后重新发起一次新复测。
          </p>
        ) : null}
        <ImprovementEvaluateForm {...identity} requestKey={randomUUID()} available={canEvaluate} />
      </section>
      <section className="merchant-account-card assistant-detail-card improvement-detail">
        <h2>4. 核对实际回答并人工判定</h2>
        <p>模型返回文字仅表示调用完成，不代表问题已经合理解决。判定通过也不会自动发布。</p>
        {detail.runs.length === 0 ? (
          <p>还没有复测记录。发起复测后，实际回答会保存在这里。</p>
        ) : null}
        {detail.runs.map((run, index) => {
          const isCurrent = evaluationIsCurrent(run, current);
          return (
            <article className="improvement-run" key={run.id}>
              <h3>{index === 0 ? '最近一次复测' : '历史复测'}</h3>
              <p>
                任务版本 {run.taskVersion} · 草稿修订 {run.draftRevision} ·{' '}
                {run.createdAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
              </p>
              <p>
                {!isCurrent
                  ? '已过期：任务、草稿或模型策略已变化，不可用于当前发布验证。'
                  : run.state === 'pending'
                    ? '尚未完成。'
                    : run.state === 'failed'
                      ? '调用失败，不算通过。'
                      : run.verdict === 'pass'
                        ? '商家已判定通过。'
                        : run.verdict === 'fail'
                          ? '商家已判定未通过。'
                          : '调用完成，待商家判定。'}
              </p>
              <details>
                <summary>查看本次测试问题与期望答案</summary>
                <p className="improvement-answer">问题：{run.question}</p>
                <p className="improvement-answer">期望：{run.expectedAnswer || '未填写'}</p>
                <small>
                  提示模板：{run.promptTemplateVersion} · 模型策略：{run.modelPolicyVersion}
                </small>
              </details>
              <p className="improvement-answer">
                {run.answer ??
                  (run.state === 'failed' ? '未取得可用回答，请稍后重试。' : '等待实际模型回答。')}
              </p>
              {index === 0 && run.state === 'completed' && run.verdict === null ? (
                <ImprovementReviewForm
                  {...identity}
                  runId={run.id}
                  requestKey={randomUUID()}
                  available={isCurrent}
                />
              ) : null}
            </article>
          );
        })}
        {detail.runs.length >= 50 ? <p>本页最多展示最近 50 次复测记录。</p> : null}
      </section>
      <section className="merchant-account-card assistant-detail-card">
        <h2>5. 确认资料，再发布更新</h2>
        {task.state === 'ready_to_publish' ? (
          <p>
            本条场景已在当前草稿上通过人工验证。请完成知识确认后发布；发布会影响此客服的新咨询。
          </p>
        ) : task.state === 'published' ? (
          <p>本条改进已关联当前线上版本。已有会话仍可能使用较早版本，检查更新请新建消费者会话。</p>
        ) : (
          <p>
            本条场景尚未在当前草稿上通过验证。建议先完成修正与复测；其他发布条件仍以发布页为准。
          </p>
        )}
        <div className="tenant-feature-grid">
          <Link className="tenant-feature-link" href={`/${merchantId}/knowledge/${assistantId}`}>
            核对并确认知识资料
          </Link>
          <Link className="tenant-feature-link" href={`/${merchantId}/publish/${assistantId}`}>
            前往测试与发布
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
