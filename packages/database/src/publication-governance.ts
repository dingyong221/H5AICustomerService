import { createHash, randomBytes } from 'node:crypto';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import {
  AssistantGovernanceError,
  inspectBusinessFacts,
  type AssistantDraftConfig,
  type PublicationGovernance,
} from '@h5cs/domain';

export type GovernanceScope = Readonly<{ merchant: Buffer; assistant: Buffer; user: Buffer }>;
/** Caller holds management, and any task row, before entering this shared write. */
export async function persistPreviewCheck(
  connection: Connection,
  scope: GovernanceScope,
  input: {
    checkId: Buffer;
    revision: number;
    factsHash: Buffer;
    question: string;
    answer: string;
    now: Date;
  },
) {
  await connection.execute(
    `INSERT INTO assistant_publication_governance
 (merchant_id,assistant_id,preview_id,preview_revision,preview_facts_hash,preview_question,
 preview_answer,preview_verdict,previewed_at,judged_by,judged_at,withdrawn_through_no,updated_at)
 VALUES (?,?,?,?,?,?,?,'pending',?,NULL,NULL,0,?) ON DUPLICATE KEY UPDATE
 preview_id=VALUES(preview_id),preview_revision=VALUES(preview_revision),
 preview_facts_hash=VALUES(preview_facts_hash),preview_question=VALUES(preview_question),
 preview_answer=VALUES(preview_answer),preview_verdict='pending',previewed_at=VALUES(previewed_at),
 judged_by=NULL,judged_at=NULL,updated_at=VALUES(updated_at)`,
    [
      scope.merchant,
      scope.assistant,
      input.checkId,
      input.revision,
      input.factsHash,
      input.question,
      input.answer,
      input.now,
      input.now,
    ],
  );
  await governanceAudit(connection, scope, 'assistant.preview_recorded', input.now, {
    checkId: input.checkId.toString('hex'),
    draftRevision: input.revision,
    questionHash: createHash('sha256').update(input.question).digest('hex'),
    answerHash: createHash('sha256').update(input.answer).digest('hex'),
  });
}
export type GovernanceRow = RowDataPacket & {
  preview_id: Buffer | null;
  preview_revision: number | null;
  preview_facts_hash: Buffer | null;
  preview_question: string | null;
  preview_answer: string | null;
  preview_verdict: string | null;
  previewed_at: Date | null;
  withdrawn_through_no: number;
  withdrawal_reason: string | null;
  withdrawn_at: Date | null;
};
export function governanceFactsHash(displayName: string, draft: AssistantDraftConfig): Buffer {
  return createHash('sha256')
    .update(JSON.stringify({ displayName, ...draft }))
    .digest();
}
export async function readGovernance(connection: Connection, scope: GovernanceScope, lock = false) {
  const [rows] = await connection.execute<GovernanceRow[]>(
    `SELECT preview_id,preview_revision,preview_facts_hash,preview_question,preview_answer,
      preview_verdict,previewed_at,withdrawn_through_no,withdrawal_reason,withdrawn_at
      FROM assistant_publication_governance WHERE merchant_id=? AND assistant_id=?${lock ? ' FOR UPDATE' : ''}`,
    [scope.merchant, scope.assistant],
  );
  return rows[0] ?? null;
}
export async function governanceAudit(
  connection: Connection,
  scope: GovernanceScope,
  action: string,
  now: Date,
  metadata: Record<string, unknown>,
  reason: string | null = null,
) {
  await connection.execute(
    `INSERT INTO audit_log (id,merchant_id,actor_type,actor_id,action,target_type,target_id,
      result,request_id,reason,metadata,occurred_at,created_at)
      VALUES (?,?,'merchant_user',?,?,'assistant',?,'success',?,?,?,?,?)`,
    [
      randomBytes(16),
      scope.merchant,
      scope.user.toString('hex'),
      action,
      scope.assistant.toString('hex'),
      randomBytes(16).toString('hex'),
      reason,
      JSON.stringify(metadata),
      now,
      now,
    ],
  );
}
export async function assertPublicationGovernance(
  connection: Connection,
  scope: GovernanceScope,
  draft: AssistantDraftConfig,
  displayName: string,
  revision: number,
  now: Date,
) {
  if (inspectBusinessFacts(draft, now).some((issue) => issue.severity === 'blocking'))
    throw new AssistantGovernanceError('FACTS_BLOCKED');
  const record = await readGovernance(connection, scope, true);
  if (
    !record ||
    record.preview_revision !== revision ||
    record.preview_verdict !== 'pass' ||
    !record.preview_facts_hash?.equals(governanceFactsHash(displayName, draft))
  )
    throw new AssistantGovernanceError('PREVIEW_REQUIRED');
}
export async function publicationGovernanceStatus(
  connection: Connection,
  scope: GovernanceScope,
  current: { draft_revision: number; display_name: string; active_release_id: Buffer | null },
  draft: AssistantDraftConfig,
  canManage: boolean,
  now: Date,
): Promise<PublicationGovernance> {
  const record = await readGovernance(connection, scope);
  const [releases] = await connection.execute<
    (RowDataPacket & {
      active_release_no: number | null;
      active_draft_revision: number | null;
      release_count: number;
    })[]
  >(
    `SELECT MAX(CASE WHEN id=? THEN release_no END) AS active_release_no,
    MAX(CASE WHEN id=? THEN draft_revision END) AS active_draft_revision,COUNT(*) AS release_count
    FROM assistant_release WHERE merchant_id=? AND assistant_id=?`,
    [current.active_release_id, current.active_release_id, scope.merchant, scope.assistant],
  );
  const [counts] = await connection.execute<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total FROM knowledge_source WHERE merchant_id=? AND assistant_id=?
     AND type='uploaded_file' AND status='active'`,
    [scope.merchant, scope.assistant],
  );
  const active = releases[0];
  const valid =
    record?.preview_revision === current.draft_revision &&
    record.preview_facts_hash?.equals(governanceFactsHash(current.display_name, draft));
  return {
    draftRevision: current.draft_revision,
    activeReleaseNo: active?.active_release_no ?? null,
    activeDraftRevision: active?.active_draft_revision ?? null,
    hasUnpublishedChanges:
      !current.active_release_id || active?.active_draft_revision !== current.draft_revision,
    hasPublishedHistory: Number(active?.release_count ?? 0) > 0,
    canManage,
    quality: {
      state: !valid
        ? 'not_tested'
        : record.preview_verdict === 'pass'
          ? 'passed'
          : record.preview_verdict === 'fail'
            ? 'failed'
            : 'needs_review',
      checkId: valid ? (record.preview_id?.toString('hex') ?? null) : null,
      question: valid ? record.preview_question : null,
      answer: valid ? record.preview_answer : null,
      testedAt: valid ? (record.previewed_at?.toISOString() ?? null) : null,
    },
    issues: inspectBusinessFacts(draft, now),
    capacity: {
      effectiveCharacters: draft.materialsSummary.length,
      maximumCharacters: 4000,
      uploadedMaterialCount: Number(counts[0]?.total ?? 0),
      sourceCoverage: 'not_tracked',
    },
    withdrawal: {
      withdrawnThroughReleaseNo: record?.withdrawn_through_no ?? 0,
      withdrawnAt: record?.withdrawn_at?.toISOString() ?? null,
      reason: record?.withdrawal_reason ?? null,
    },
  };
}
