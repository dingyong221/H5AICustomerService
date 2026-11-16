import {
  AuthoringTaskError,
  KnowledgeOrganizationError,
  type AssistantDraftConfig,
  type AuthoringTaskKind,
} from '@h5cs/domain';
import { draftExpandRequestSchema, previewReplyRequestSchema } from '@h5cs/contracts';
import type { DraftExpandRequest, PreviewReplyRequest } from '@h5cs/contracts';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import {
  authorizeKnowledgeScope,
  knowledgeBytes,
  knowledgeHash,
  knowledgeObject,
  knowledgeRevision,
  type KnowledgeScope,
  type KnowledgeJobRow,
} from './knowledge-organization-contract.js';
import { governanceFactsHash, readGovernance } from './publication-governance.js';
import { parseAssistantDraft } from './assistant-lifecycle-repository.js';
export type AuthoringScope = KnowledgeScope;
type CommonPayload = {
  schemaVersion: 1;
  merchantId: string;
  assistantId: string;
  requesterUserId: string;
  inputRevision: number;
  requestHash: string;
  retryOf?: string;
};
export type AuthoringPayload = CommonPayload &
  (
    | {
        kind: 'draft.expand';
        handlerVersion: 'draft-expand-v1';
        input: DraftExpandRequest;
        inputFieldHash: string;
      }
    | {
        kind: 'preview.reply';
        handlerVersion: 'preview-reply-v1';
        input: PreviewReplyRequest;
        inputFactsHash: string;
        previousPreviewId: string | null;
      }
  );
export type AuthoringTaskClaim = Readonly<{
  jobId: string;
  merchantId: string;
  assistantId: string;
  requesterUserId: string;
  leaseOwner: string;
  claimGeneration: string;
  leaseUntil: Date;
  payload: AuthoringPayload;
  facts?: { assistantName: string; draft: AssistantDraftConfig };
}>;
export const authoringOperation = (kind: AuthoringTaskKind) =>
  kind === 'draft.expand' ? ('writing' as const) : ('preview' as const);
export function authoringObject(value: unknown) {
  try {
    return knowledgeObject(value);
  } catch {
    throw new AuthoringTaskError('INVALID_REQUEST');
  }
}
export function authoringBytes(value: string) {
  try {
    return knowledgeBytes(value);
  } catch {
    throw new AuthoringTaskError('INVALID_REQUEST');
  }
}
export function decodeAuthoringPayload(value: unknown): AuthoringPayload {
  const p = authoringObject(value);
  if (
    p['schemaVersion'] !== 1 ||
    !knowledgeRevision(p['inputRevision']) ||
    typeof p['requestHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(p['requestHash'])
  )
    throw new AuthoringTaskError('INVALID_REQUEST');
  for (const k of ['merchantId', 'assistantId', 'requesterUserId'] as const) {
    if (typeof p[k] !== 'string') throw new AuthoringTaskError('INVALID_REQUEST');
    authoringBytes(p[k]);
  }
  if (p['retryOf'] !== undefined) {
    if (typeof p['retryOf'] !== 'string') throw new AuthoringTaskError('INVALID_REQUEST');
    authoringBytes(p['retryOf']);
  }
  const common = {
    schemaVersion: 1 as const,
    merchantId: p['merchantId'] as string,
    assistantId: p['assistantId'] as string,
    requesterUserId: p['requesterUserId'] as string,
    inputRevision: p['inputRevision'],
    requestHash: p['requestHash'],
    ...(typeof p['retryOf'] === 'string' ? { retryOf: p['retryOf'] } : {}),
  };
  if (p['kind'] === 'draft.expand' && p['handlerVersion'] === 'draft-expand-v1') {
    const parsed = draftExpandRequestSchema.safeParse(p['input']);
    if (
      !parsed.success ||
      parsed.data.revision !== p['inputRevision'] ||
      p['inputFieldHash'] !== knowledgeHash(parsed.data.currentText)
    )
      throw new AuthoringTaskError('INVALID_REQUEST');
    return {
      ...common,
      kind: 'draft.expand',
      handlerVersion: 'draft-expand-v1',
      input: parsed.data,
      inputFieldHash: p['inputFieldHash'] as string,
    };
  }
  if (p['kind'] === 'preview.reply' && p['handlerVersion'] === 'preview-reply-v1') {
    const parsed = previewReplyRequestSchema.safeParse(p['input']);
    if (
      !parsed.success ||
      parsed.data.revision !== p['inputRevision'] ||
      typeof p['inputFactsHash'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(p['inputFactsHash']) ||
      (p['previousPreviewId'] !== null && typeof p['previousPreviewId'] !== 'string')
    )
      throw new AuthoringTaskError('INVALID_REQUEST');
    if (p['previousPreviewId'] !== null) authoringBytes(p['previousPreviewId'] as string);
    return {
      ...common,
      kind: 'preview.reply',
      handlerVersion: 'preview-reply-v1',
      input: parsed.data,
      inputFactsHash: p['inputFactsHash'],
      previousPreviewId: p['previousPreviewId'] as string | null,
    };
  }
  throw new AuthoringTaskError('INVALID_REQUEST');
}
export async function authorizeAuthoringScope(c: Connection, scope: AuthoringScope, lock = false) {
  let revision: number;
  try {
    revision = await authorizeKnowledgeScope(c, scope, lock);
  } catch (e) {
    if (e instanceof KnowledgeOrganizationError) throw new AuthoringTaskError(e.code);
    throw e;
  }
  const [rows] = await c.execute<
    (RowDataPacket & { display_name: string; config: string | AssistantDraftConfig })[]
  >(
    'SELECT a.display_name,d.config FROM assistant a JOIN assistant_draft d ON d.assistant_id=a.id AND d.merchant_id=a.merchant_id WHERE a.id=? AND a.merchant_id=?',
    [authoringBytes(scope.assistantId), authoringBytes(scope.merchantId)],
  );
  if (!rows[0]) throw new AuthoringTaskError('NOT_FOUND');
  // MySQL JSON key order is not the draft's canonical business field order.
  // Use the same parsing/normalization as publication and synchronous preview;
  // changing the shared hash would invalidate already-confirmed legacy records.
  const draft = parseAssistantDraft(rows[0].config);
  return {
    revision,
    assistantName: rows[0].display_name,
    draft,
    factsHash: governanceFactsHash(rows[0].display_name, draft).toString('hex'),
  };
}
export async function currentPreviewId(c: Connection, scope: AuthoringScope, lock = false) {
  return (
    (
      await readGovernance(
        c,
        {
          merchant: authoringBytes(scope.merchantId),
          assistant: authoringBytes(scope.assistantId),
          user: authoringBytes(scope.userId),
        },
        lock,
      )
    )?.preview_id?.toString('hex') ?? null
  );
}
export async function lockAuthoringJob(c: Connection, scope: AuthoringScope, taskId: string) {
  const [rows] = await c.execute<KnowledgeJobRow[]>(
    "SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE id=? AND merchant_id=? AND type IN ('draft.expand','preview.reply') FOR UPDATE",
    [authoringBytes(taskId), authoringBytes(scope.merchantId)],
  );
  const job = rows[0];
  if (!job) throw new AuthoringTaskError('NOT_FOUND');
  const p = decodeAuthoringPayload(job.payload);
  if (
    p.merchantId !== scope.merchantId ||
    p.assistantId !== scope.assistantId ||
    job['type'] !== p.kind
  )
    throw new AuthoringTaskError('NOT_FOUND');
  return { job, payload: p };
}
export async function lockValidAuthoringClaim(c: Connection, claim: AuthoringTaskClaim, now: Date) {
  if (
    !Number.isFinite(now.getTime()) ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(claim.leaseOwner) ||
    !/^[1-9][0-9]{0,19}$/u.test(claim.claimGeneration) ||
    BigInt(claim.claimGeneration) > 18446744073709551615n
  )
    throw new AuthoringTaskError('INVALID_REQUEST');
  const scope = {
    merchantId: claim.merchantId,
    assistantId: claim.assistantId,
    userId: claim.requesterUserId,
  };
  const current = await authorizeAuthoringScope(c, scope, true),
    { job, payload } = await lockAuthoringJob(c, scope, claim.jobId);
  if (
    job.state !== 'processing' ||
    job.lease_owner !== claim.leaseOwner ||
    job.claim_generation !== claim.claimGeneration ||
    !job.lease_until ||
    job.lease_until <= now ||
    JSON.stringify(payload) !== JSON.stringify(claim.payload) ||
    payload.requesterUserId !== claim.requesterUserId
  )
    throw new AuthoringTaskError('STALE_CLAIM');
  return { scope, current, job, payload };
}
export async function assertAuthoringInput(
  c: Connection,
  scope: AuthoringScope,
  payload: AuthoringPayload,
  current: Awaited<ReturnType<typeof authorizeAuthoringScope>>,
) {
  if (current.revision !== payload.inputRevision) throw new AuthoringTaskError('INPUT_CHANGED');
  if (payload.kind === 'preview.reply') {
    if (current.factsHash !== payload.inputFactsHash) throw new AuthoringTaskError('INPUT_CHANGED');
    if ((await currentPreviewId(c, scope)) !== payload.previousPreviewId)
      throw new AuthoringTaskError('PREVIEW_SUPERSEDED');
  }
}
