import { createHash } from 'node:crypto';
import { KnowledgeOrganizationError } from '@h5cs/domain';
import type { KnowledgeSourceReference, KnowledgeModelOutcome } from '@h5cs/domain';
import type { Connection, RowDataPacket } from 'mysql2/promise';

export type KnowledgeScope = Readonly<{ merchantId: string; assistantId: string; userId: string }>;
export type KnowledgeTaskPayload = Readonly<{
  schemaVersion: 1;
  handlerVersion: 'knowledge-organize-v1';
  merchantId: string;
  assistantId: string;
  requesterUserId: string;
  inputRevision: number;
  sources: readonly KnowledgeSourceReference[];
  requestHash: string;
  retryOf?: string;
}>;
export type KnowledgeOrganizationClaim = Readonly<{
  jobId: string;
  merchantId: string;
  assistantId: string;
  requesterUserId: string;
  leaseOwner: string;
  claimGeneration: string;
  leaseUntil: Date;
  payload: KnowledgeTaskPayload;
  text: string;
}>;
export type KnowledgeJobRow = RowDataPacket & {
  id: Buffer;
  merchant_id: Buffer;
  payload: unknown;
  result: unknown;
  state: string;
  attempt: number;
  claim_generation: string;
  lease_owner: string | null;
  lease_until: Date | null;
  model_outcome: KnowledgeModelOutcome;
  model_attempt_id: Buffer | null;
  last_error_code: string | null;
  created_at: Date;
  updated_at: Date;
};
export const knowledgeBytes = (value: string): Buffer => {
  if (!/^[a-f0-9]{32}$/u.test(value)) throw new KnowledgeOrganizationError('INVALID_REQUEST');
  return Buffer.from(value, 'hex');
};
export const knowledgeHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const knowledgeObject = (value: unknown): Record<string, unknown> => {
  let data: unknown;
  try {
    data = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new KnowledgeOrganizationError('INVALID_REQUEST');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new KnowledgeOrganizationError('INVALID_REQUEST');
  return data as Record<string, unknown>;
};
export const knowledgeRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 2_147_483_647;
export function decodeKnowledgePayload(value: unknown): KnowledgeTaskPayload {
  const p = knowledgeObject(value);
  if (
    p['schemaVersion'] !== 1 ||
    p['handlerVersion'] !== 'knowledge-organize-v1' ||
    !knowledgeRevision(p['inputRevision']) ||
    typeof p['requestHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(p['requestHash']) ||
    !Array.isArray(p['sources']) ||
    p['sources'].length < 1 ||
    p['sources'].length > 5
  )
    throw new KnowledgeOrganizationError('INVALID_REQUEST');
  for (const key of ['merchantId', 'assistantId', 'requesterUserId'] as const) {
    if (typeof p[key] !== 'string') throw new KnowledgeOrganizationError('INVALID_REQUEST');
    knowledgeBytes(p[key]);
  }
  const sources = p['sources'].map((s) => {
    const x = knowledgeObject(s);
    if (
      typeof x['id'] !== 'string' ||
      !knowledgeRevision(x['revision']) ||
      typeof x['contentHash'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(x['contentHash']) ||
      typeof x['name'] !== 'string' ||
      !x['name'].trim() ||
      x['name'].length > 200
    )
      throw new KnowledgeOrganizationError('INVALID_REQUEST');
    knowledgeBytes(x['id']);
    return { id: x['id'], revision: x['revision'], contentHash: x['contentHash'], name: x['name'] };
  });
  if (new Set(sources.map((s) => s.id)).size !== sources.length)
    throw new KnowledgeOrganizationError('INVALID_REQUEST');
  if (p['retryOf'] !== undefined) {
    if (typeof p['retryOf'] !== 'string') throw new KnowledgeOrganizationError('INVALID_REQUEST');
    knowledgeBytes(p['retryOf']);
  }
  return {
    schemaVersion: 1,
    handlerVersion: 'knowledge-organize-v1',
    merchantId: p['merchantId'] as string,
    assistantId: p['assistantId'] as string,
    requesterUserId: p['requesterUserId'] as string,
    inputRevision: p['inputRevision'],
    requestHash: p['requestHash'],
    sources,
    ...(typeof p['retryOf'] === 'string' ? { retryOf: p['retryOf'] } : {}),
  };
}

// All knowledge-task writes lock management -> job -> sources -> model receipt.
// This matches lifecycle/material writes; never hold a job then wait for management.
export async function authorizeKnowledgeScope(
  connection: Connection,
  scope: KnowledgeScope,
  lock = false,
): Promise<number> {
  const [rows] = await connection.execute<(RowDataPacket & { revision: number })[]>(
    `SELECT d.revision FROM assistant a JOIN merchant_assistant ca ON ca.merchant_id=a.merchant_id AND ca.assistant_id=a.id JOIN assistant_draft d ON d.merchant_id=a.merchant_id AND d.assistant_id=a.id JOIN merchant m ON m.id=a.merchant_id JOIN merchant_membership mm ON mm.merchant_id=m.id JOIN merchant_user u ON u.id=mm.merchant_user_id WHERE a.merchant_id=? AND a.id=? AND mm.merchant_user_id=? AND mm.status='active' AND mm.role IN ('owner','admin','editor') AND u.status='active' AND m.status='active' AND a.status<>'paused' ${lock ? 'FOR UPDATE' : ''}`,
    [
      knowledgeBytes(scope.merchantId),
      knowledgeBytes(scope.assistantId),
      knowledgeBytes(scope.userId),
    ],
  );
  if (rows.length !== 1) throw new KnowledgeOrganizationError('NOT_FOUND');
  return rows[0]!.revision;
}
export async function loadKnowledgeSources(
  connection: Connection,
  scope: Pick<KnowledgeScope, 'merchantId' | 'assistantId'>,
  ids: readonly string[],
  lock = false,
): Promise<{ sources: KnowledgeSourceReference[]; text: string }> {
  if (ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length)
    throw new KnowledgeOrganizationError('INVALID_REQUEST');
  const [rows] = await connection.execute<
    (RowDataPacket & {
      id: Buffer;
      title: string;
      revision_no: number;
      content_hash: Buffer;
      source_metadata: unknown;
    })[]
  >(
    `SELECT ks.id,ks.title,kr.revision_no,kr.content_hash,kr.source_metadata FROM knowledge_source ks JOIN knowledge_revision kr ON kr.merchant_id=ks.merchant_id AND kr.assistant_id=ks.assistant_id AND kr.source_id=ks.id AND kr.revision_no=ks.current_revision_no WHERE ks.merchant_id=? AND ks.assistant_id=? AND ks.type='uploaded_file' AND ks.status='active' AND ks.id IN (${ids.map(() => '?').join(',')}) ORDER BY ks.id ${lock ? 'FOR UPDATE' : ''}`,
    [
      knowledgeBytes(scope.merchantId),
      knowledgeBytes(scope.assistantId),
      ...ids.map(knowledgeBytes),
    ],
  );
  if (rows.length !== ids.length) throw new KnowledgeOrganizationError('INPUT_CHANGED');
  const texts: string[] = [],
    sources: KnowledgeSourceReference[] = [];
  for (const sourceId of [...ids].sort()) {
    const row = rows.find((r) => r.id.toString('hex') === sourceId)!;
    const meta = knowledgeObject(row.source_metadata),
      text = meta['text'];
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 24000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
      knowledgeHash(text) !== row.content_hash.toString('hex')
    )
      throw new KnowledgeOrganizationError('INPUT_CHANGED');
    sources.push({
      id: sourceId,
      revision: row.revision_no,
      contentHash: row.content_hash.toString('hex'),
      name: row.title,
    });
    texts.push(`【来源：${row.title}】\n${text}`);
  }
  const text = texts.join('\n\n');
  if (text.length > 24000) throw new KnowledgeOrganizationError('INVALID_REQUEST');
  return { sources, text };
}
export function sameKnowledgeSources(
  a: readonly KnowledgeSourceReference[],
  b: readonly KnowledgeSourceReference[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export async function lockKnowledgeJob(
  connection: Connection,
  scope: KnowledgeScope,
  taskId: string,
): Promise<KnowledgeJobRow> {
  const [rows] = await connection.execute<KnowledgeJobRow[]>(
    `SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE id=? AND merchant_id=? AND type='knowledge.organize' LIMIT 1 FOR UPDATE`,
    [knowledgeBytes(taskId), knowledgeBytes(scope.merchantId)],
  );
  const row = rows[0];
  if (!row) throw new KnowledgeOrganizationError('NOT_FOUND');
  const p = decodeKnowledgePayload(row.payload);
  if (p.merchantId !== scope.merchantId || p.assistantId !== scope.assistantId)
    throw new KnowledgeOrganizationError('NOT_FOUND');
  return row;
}
export async function lockValidKnowledgeClaim(
  connection: Connection,
  claim: KnowledgeOrganizationClaim,
  now: Date,
) {
  if (
    !Number.isFinite(now.getTime()) ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(claim.leaseOwner) ||
    !/^[1-9][0-9]{0,19}$/u.test(claim.claimGeneration) ||
    BigInt(claim.claimGeneration) > 18_446_744_073_709_551_615n
  )
    throw new KnowledgeOrganizationError('INVALID_REQUEST');
  const scope = {
    merchantId: claim.merchantId,
    assistantId: claim.assistantId,
    userId: claim.requesterUserId,
  };
  const revision = await authorizeKnowledgeScope(connection, scope, true),
    job = await lockKnowledgeJob(connection, scope, claim.jobId),
    payload = decodeKnowledgePayload(job.payload);
  if (
    job.state !== 'processing' ||
    job.lease_owner !== claim.leaseOwner ||
    job.claim_generation !== claim.claimGeneration ||
    !job.lease_until ||
    job.lease_until <= now ||
    JSON.stringify(payload) !== JSON.stringify(claim.payload) ||
    payload.requesterUserId !== claim.requesterUserId
  )
    throw new KnowledgeOrganizationError('STALE_CLAIM');
  return { job, payload, scope, revision };
}
