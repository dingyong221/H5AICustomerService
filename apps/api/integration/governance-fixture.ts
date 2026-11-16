import type { MySqlAssistantLifecycleRepository } from '@h5cs/database';
import type { AssistantId, MerchantId, MerchantUserId } from '@h5cs/domain';

/** Synthetic durable-preview fixture only; this does not claim model-answer quality. */
export async function approveSyntheticPreview(
  repository: MySqlAssistantLifecycleRepository,
  actor: { merchantId: MerchantId; merchantUserId: MerchantUserId; assistantId: AssistantId },
  revision: number,
) {
  // This helper is also used after later revisions/retests, so a previous
  // check can exist. Capture the server-owned value before producing a reply.
  const snapshot = await repository.findManagementSnapshot(actor.merchantId, actor.assistantId);
  if (!snapshot) throw new Error('Synthetic preview requires its retained assistant');
  const preview = await repository.savePreviewCheck({
    ...actor,
    expectedDraftRevision: revision,
    expectedPreviousPreviewId: snapshot.previousPreviewCheckId,
    question: 'SYNTHETIC fixture business question',
    answer: 'SYNTHETIC fixture answer; not a supplier response',
    now: new Date(),
  });
  await repository.judgePreviewCheck({
    ...actor,
    expectedDraftRevision: revision,
    checkId: preview.checkId,
    verdict: 'pass',
    now: new Date(),
  });
}
