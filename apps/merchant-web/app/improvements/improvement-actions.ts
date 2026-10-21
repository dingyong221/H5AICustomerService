'use server';

import { randomUUID } from 'node:crypto';
import { loadDatabaseConfig, MySqlAssistantImprovementRepository } from '@h5cs/database';
import { ImprovementConflictError } from '@h5cs/domain';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { currentMerchantForWrite } from '../account/merchant-actions';
import { publicationPolicy } from '../workspace/publication-policy';
import { requestWorkerPreview } from '../workspace/worker-preview';
import {
  emptyImprovementAction,
  parseImprovementEdit,
  positiveVersion,
  type ImprovementActionState,
} from './improvement-model';

const id = (value: FormDataEntryValue | null): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);

const failed = (error: string): ImprovementActionState => ({
  ...emptyImprovementAction,
  error,
  outcome: 'rejected',
});

const failedWrite = (error: unknown): ImprovementActionState => ({
  ...failed(conflictMessage(error)),
  outcome:
    error instanceof ImprovementConflictError && error.code !== 'idempotency_conflict'
      ? 'rejected'
      : 'unknown',
});

const conflictMessage = (error: unknown): string => {
  if (error instanceof ImprovementConflictError) {
    switch (error.code) {
      case 'stale':
        return '任务或草稿已变化。当前输入仍保留，请复制后刷新，核对新版本再操作。';
      case 'unavailable':
        return '任务不存在、客服已暂停或你没有此商家的权限。';
      case 'too_long':
        return '合并后的商品或服务资料超过 4000 字上限。未改动草稿，请先整理或删去重复资料再重试。';
      case 'managed_block_changed':
        return '该 FAQ 已在草稿中被手动修改，不能自动覆盖。请对照下方修正内容，先人工核对草稿。';
      case 'idempotency_conflict':
        return '同一请求已提交过不同内容。请刷新查看任务状态后再操作。';
      default:
        return '内容不符合要求。问题、期望答案和备注各不超过 2000 字，请勿包含 FAQ 管理标记。';
    }
  }
  return '操作结果尚未确认。输入仍保留，请刷新核对记录，不要连续重复提交。';
};

async function authorize(form: FormData) {
  const origin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!origin || (await headers()).get('origin') !== origin)
    return { error: '请求来源校验失败，请从自己的商家后台操作。' } as const;
  const merchantId = form.get('merchantId');
  const assistantId = form.get('assistantId');
  const csrfToken = form.get('csrfToken');
  const requestKey = form.get('requestKey');
  if (
    !id(merchantId) ||
    !id(assistantId) ||
    typeof csrfToken !== 'string' ||
    typeof requestKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(requestKey)
  )
    return { error: '请求参数无效，请刷新页面重试。' } as const;
  const member = await currentMerchantForWrite(merchantId, csrfToken);
  if (!member) return { error: '登录或安全校验已失效，请重新登录当前商家。' } as const;
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库暂不可用，请稍后重试。' } as const;
  return {
    repository: new MySqlAssistantImprovementRepository(database.config),
    actor: {
      merchantId,
      assistantId,
      merchantUserId: member.merchantUserId,
      requestKey,
      now: new Date(),
    },
  } as const;
}

function refresh(merchantId: string, assistantId: string, improvementId: string) {
  revalidatePath(`/${merchantId}`);
  revalidatePath(`/${merchantId}/improvements`);
  revalidatePath(`/${merchantId}/improvements/${improvementId}`);
  for (const section of ['drafts', 'knowledge', 'preview', 'publish'])
    revalidatePath(`/${merchantId}/${section}/${assistantId}`);
}

function succeeded(
  merchantId: string,
  assistantId: string,
  improvementId: string,
  message: string,
): ImprovementActionState {
  refresh(merchantId, assistantId, improvementId);
  return { error: null, message, improvementId, resultKey: randomUUID(), outcome: 'confirmed' };
}

export async function createImprovementAction(
  _previous: ImprovementActionState,
  form: FormData,
): Promise<ImprovementActionState> {
  const authorized = await authorize(form);
  if ('error' in authorized) return failed(authorized.error);
  const edit = parseImprovementEdit(form);
  if (!edit) return failed('请填写 1 至 2000 字的问题；期望答案和备注各不超过 2000 字。');
  const sourceMessageId = form.get('sourceMessageId');
  if (sourceMessageId !== null && sourceMessageId !== '' && !id(sourceMessageId))
    return failed('来源消息无效，请从原咨询重新打开。');
  try {
    const input = { ...authorized.actor, ...edit };
    const task = id(sourceMessageId)
      ? await authorized.repository.createFromMessage({ ...input, sourceMessageId })
      : await authorized.repository.createScenario(input);
    return succeeded(
      input.merchantId,
      input.assistantId,
      task.id,
      '已建立改进任务，原始咨询不会被修改。',
    );
  } catch (error) {
    return failedWrite(error);
  }
}

export async function updateImprovementAction(
  _previous: ImprovementActionState,
  form: FormData,
): Promise<ImprovementActionState> {
  const authorized = await authorize(form);
  if ('error' in authorized) return failed(authorized.error);
  const edit = parseImprovementEdit(form);
  const improvementId = form.get('improvementId');
  const expectedVersion = positiveVersion(form.get('expectedVersion'));
  if (!edit || !id(improvementId) || expectedVersion === null)
    return failed('任务内容无效，请填写问题、原因和期望答案并核对版本。');
  try {
    const task = await authorized.repository.update({
      ...authorized.actor,
      ...edit,
      improvementId,
      expectedVersion,
    });
    return succeeded(
      authorized.actor.merchantId,
      authorized.actor.assistantId,
      task.id,
      '任务已保存。之前的复测和通过判定不再代表新任务，请重新应用修正并复测。',
    );
  } catch (error) {
    return failedWrite(error);
  }
}

export async function applyImprovementAction(
  _previous: ImprovementActionState,
  form: FormData,
): Promise<ImprovementActionState> {
  const authorized = await authorize(form);
  if ('error' in authorized) return failed(authorized.error);
  const improvementId = form.get('improvementId');
  const expectedVersion = positiveVersion(form.get('expectedVersion'));
  const expectedDraftRevision = positiveVersion(form.get('expectedDraftRevision'));
  if (
    !id(improvementId) ||
    expectedVersion === null ||
    expectedDraftRevision === null ||
    form.get('factsVerified') !== 'yes'
  )
    return failed('请先核对真实业务事实，并勾选确认后再应用到草稿。');
  try {
    const result = await authorized.repository.applyCorrection({
      ...authorized.actor,
      improvementId,
      expectedVersion,
      expectedDraftRevision,
    });
    return succeeded(
      authorized.actor.merchantId,
      authorized.actor.assistantId,
      improvementId,
      result.draftRevision === expectedDraftRevision
        ? `该 FAQ 已在草稿修订 ${result.draftRevision} 中，本次没有重复修改草稿。请核对本条当前复测状态。`
        : `修正已写入草稿修订 ${result.draftRevision} 的 FAQ。资料确认已失效，消费者线上版本尚未改变；下一步请复测。`,
    );
  } catch (error) {
    return failedWrite(error);
  }
}

export async function evaluateImprovementAction(
  _previous: ImprovementActionState,
  form: FormData,
): Promise<ImprovementActionState> {
  const authorized = await authorize(form);
  if ('error' in authorized) return failed(authorized.error);
  const improvementId = form.get('improvementId');
  const expectedVersion = positiveVersion(form.get('expectedVersion'));
  const expectedDraftRevision = positiveVersion(form.get('expectedDraftRevision'));
  if (
    !id(improvementId) ||
    expectedVersion === null ||
    expectedDraftRevision === null ||
    form.get('modelConsent') !== 'yes'
  )
    return failed('请确认把当前草稿业务资料和本条问题发送至阿里云千问进行复测。');
  const policy = publicationPolicy();
  if (!policy.ready) return failed(policy.reason);
  try {
    const started = await authorized.repository.startEvaluation({
      ...authorized.actor,
      improvementId,
      expectedVersion,
      expectedDraftRevision,
      promptTemplateVersion: policy.promptTemplateVersion,
      modelPolicyVersion: policy.modelPolicyVersion,
    });
    if (!started.started || started.run.state !== 'pending')
      return succeeded(
        authorized.actor.merchantId,
        authorized.actor.assistantId,
        improvementId,
        '此复测请求已经提交，未重复发送模型请求。请刷新查看已保存的结果。',
      );
    let answer: string | null = null;
    let errorCode: string | null = null;
    try {
      answer = await requestWorkerPreview({
        merchantId: authorized.actor.merchantId,
        assistantName: started.assistantName,
        draft: started.draft,
        question: started.run.question,
      });
    } catch {
      errorCode = 'preview_unavailable';
    }
    await authorized.repository.finishEvaluation({
      ...authorized.actor,
      requestKey: randomUUID(),
      now: new Date(),
      improvementId,
      runId: started.run.id,
      answer,
      errorCode,
    });
    const state = succeeded(
      authorized.actor.merchantId,
      authorized.actor.assistantId,
      improvementId,
      errorCode
        ? '本次复测失败已记录。请稍后重试，失败不算通过。'
        : 'AI 实际回答已记录，尚未判定通过。请核对事实、适用条件和后续处理渠道，再选择是否符合预期。',
    );
    return errorCode ? { ...state, error: 'AI 试聊服务暂不可用；请稍后重新发起复测。' } : state;
  } catch (error) {
    return failedWrite(error);
  }
}

export async function reviewImprovementAction(
  _previous: ImprovementActionState,
  form: FormData,
): Promise<ImprovementActionState> {
  const authorized = await authorize(form);
  if ('error' in authorized) return failed(authorized.error);
  const improvementId = form.get('improvementId');
  const runId = form.get('runId');
  const expectedVersion = positiveVersion(form.get('expectedVersion'));
  const expectedDraftRevision = positiveVersion(form.get('expectedDraftRevision'));
  const verdict = form.get('verdict');
  if (
    !id(improvementId) ||
    !id(runId) ||
    expectedVersion === null ||
    expectedDraftRevision === null ||
    (verdict !== 'pass' && verdict !== 'fail')
  )
    return failed('请选择对当前复测的人工判定。');
  try {
    await authorized.repository.reviewEvaluation({
      ...authorized.actor,
      improvementId,
      runId,
      expectedVersion,
      expectedDraftRevision,
      verdict,
    });
    return succeeded(
      authorized.actor.merchantId,
      authorized.actor.assistantId,
      improvementId,
      verdict === 'pass'
        ? '已记录人工通过。此操作不会自动确认资料或发布；请完成知识确认并发布新版本。'
        : '已记录未通过。请补充或修正期望答案，再应用到草稿并复测。',
    );
  } catch (error) {
    return failedWrite(error);
  }
}
