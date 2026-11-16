import { randomBytes } from 'node:crypto';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';
import type { ConversationTurnClaim } from './conversation-turn-job-repository.js';
import {
  ConversationTurnJobError,
  jobBytes,
  lockValidConversationClaim,
} from './conversation-job-contract.js';
import { MarketplaceAccessError } from './marketplace-repository.js';
import {
  lockValidAuthoringClaim,
  assertAuthoringInput,
  authoringOperation,
  type AuthoringTaskClaim,
} from './authoring-task-contract.js';
import {
  lockValidKnowledgeClaim,
  loadKnowledgeSources,
  sameKnowledgeSources,
  type KnowledgeOrganizationClaim,
} from './knowledge-organization-contract.js';

export type ModelOperation = 'consumer' | 'preview' | 'writing' | 'organize';
export type RecordedModelOutcome = 'succeeded' | 'failed' | 'unknown' | 'not_dispatched';
const product = 'h5ai-self-service-v1';
const validTime = (now: Date) => {
  if (!Number.isFinite(now.getTime())) throw new ConversationTurnJobError();
};
/** A supplier-attempt receipt, not a business result or a stage-2 capability run. */
export class MySqlModelCallAttemptRepository {
  public constructor(private readonly database: DatabaseConnectionConfig) {}

  public async markDispatch(
    input: {
      merchantId: string;
      operation: ModelOperation;
      claim?: ConversationTurnClaim;
      knowledgeClaim?: KnowledgeOrganizationClaim;
      authoringClaim?: AuthoringTaskClaim;
    },
    now: Date,
  ): Promise<{ attemptId: string }> {
    validTime(now);
    const merchant = jobBytes(input.merchantId);
    if (
      !['consumer', 'preview', 'writing', 'organize'].includes(input.operation) ||
      (input.operation === 'consumer') !== Boolean(input.claim) ||
      (input.claim && input.claim.merchantId !== input.merchantId) ||
      (input.authoringClaim &&
        (input.claim ||
          input.knowledgeClaim ||
          input.authoringClaim.merchantId !== input.merchantId ||
          input.operation !== authoringOperation(input.authoringClaim.payload.kind))) ||
      (input.knowledgeClaim &&
        (input.operation !== 'organize' ||
          input.claim ||
          input.knowledgeClaim.merchantId !== input.merchantId))
    )
      throw new ConversationTurnJobError();
    const connection = await this.database.openConnection();
    let committing = false;
    try {
      await connection.beginTransaction();
      let jobId: Buffer | null = null;
      if (input.claim) {
        const locked = await lockValidConversationClaim(connection, input.claim, now);
        if (!locked || locked.job.model_outcome !== 'none')
          throw new ConversationTurnJobError('Claim is stale', 'STALE_CLAIM');
        jobId = locked.ids.jobId;
        const [sessions] = await connection.execute<(RowDataPacket & { id: Buffer })[]>(
          `SELECT cs.id FROM conversation_session cs
            JOIN merchant m ON m.id = cs.merchant_id
            JOIN assistant a ON a.id = cs.assistant_id AND a.merchant_id = cs.merchant_id
            JOIN merchant_assistant ma ON ma.merchant_id = a.merchant_id AND ma.assistant_id = a.id
            JOIN assistant_release r ON r.id = cs.release_id AND r.merchant_id = cs.merchant_id AND r.assistant_id = cs.assistant_id
           WHERE cs.id = ? AND cs.merchant_id = ? AND cs.assistant_id = ? AND cs.release_id = ?
             AND cs.active_turn_id = ? AND cs.status = 'active' AND cs.expires_at > ?
             AND m.status = 'active' AND a.status = 'active' LIMIT 1 FOR UPDATE`,
          [
            locked.ids.sessionId,
            merchant,
            locked.ids.assistantId,
            locked.ids.releaseId,
            locked.ids.turnId,
            now,
          ],
        );
        if (!sessions[0]) throw new ConversationTurnJobError('Claim is stale', 'STALE_CLAIM');
      } else if (input.authoringClaim) {
        const locked = await lockValidAuthoringClaim(connection, input.authoringClaim, now);
        await assertAuthoringInput(connection, locked.scope, locked.payload, locked.current);
        if (
          locked.job.model_outcome !== 'none' ||
          (locked.payload.kind === 'preview.reply' &&
            JSON.stringify(input.authoringClaim.facts) !==
              JSON.stringify({
                assistantName: locked.current.assistantName,
                draft: locked.current.draft,
              }))
        )
          throw new ConversationTurnJobError('Claim is stale', 'STALE_CLAIM');
        jobId = locked.job.id;
      } else if (input.knowledgeClaim) {
        const locked = await lockValidKnowledgeClaim(connection, input.knowledgeClaim, now);
        const source = await loadKnowledgeSources(
          connection,
          locked.scope,
          locked.payload.sources.map((s) => s.id),
          true,
        );
        if (
          locked.job.model_outcome !== 'none' ||
          locked.revision !== locked.payload.inputRevision ||
          !sameKnowledgeSources(source.sources, locked.payload.sources) ||
          source.text !== input.knowledgeClaim.text
        )
          throw new ConversationTurnJobError('Claim is stale', 'STALE_CLAIM');
        jobId = locked.job.id;
      } else {
        const [merchants] = await connection.execute<(RowDataPacket & { id: Buffer })[]>(
          `SELECT id FROM merchant WHERE id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
          [merchant],
        );
        if (!merchants[0]) throw new MarketplaceAccessError('not_eligible');
      }
      const [rows] = await connection.execute<
        (RowDataPacket & {
          subject_digest: Buffer;
          is_eligible: number;
          model_call_limit: number | null;
          model_calls_reserved: number;
        })[]
      >(
        `SELECT e.subject_digest,
                (e.status = 'active' AND e.valid_from <= ? AND (e.expires_at IS NULL OR e.expires_at > ?)) is_eligible,
                e.model_call_limit, e.model_calls_reserved
           FROM marketplace_allocation a JOIN marketplace_entitlement e
             ON e.subject_digest = a.subject_digest AND e.product = a.product
          WHERE a.merchant_id = ? AND a.product = ? FOR UPDATE`,
        [now, now, merchant, product],
      );
      const entitlement = rows[0];
      if (entitlement && entitlement.is_eligible !== 1)
        throw new MarketplaceAccessError('not_eligible');
      if (
        entitlement &&
        entitlement.model_call_limit !== null &&
        entitlement.model_calls_reserved >= entitlement.model_call_limit
      )
        throw new MarketplaceAccessError('quota_exhausted');
      const attempt = randomBytes(16);
      if (entitlement) {
        await connection.execute(
          `UPDATE marketplace_entitlement SET model_calls_reserved = model_calls_reserved + 1
          WHERE subject_digest = ? AND product = ?`,
          [entitlement.subject_digest, product],
        );
        await connection.execute(
          `INSERT INTO marketplace_model_attempt
          (id, subject_digest, product, operation, state, created_at) VALUES (?, ?, ?, ?, 'reserved_may_charge', ?)`,
          [attempt, entitlement.subject_digest, product, input.operation, now],
        );
      }
      await connection.execute(
        `INSERT INTO model_call_attempt
        (id, merchant_id, job_id, claim_generation, operation, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'dispatched', ?, ?)`,
        [
          attempt,
          merchant,
          jobId,
          input.claim?.claimGeneration ??
            input.knowledgeClaim?.claimGeneration ??
            input.authoringClaim?.claimGeneration ??
            null,
          input.operation,
          now,
          now,
        ],
      );
      if (jobId) {
        await connection.execute(
          `UPDATE job SET model_outcome = 'dispatched', model_attempt_id = ?, updated_at = ?
          WHERE id = ? AND claim_generation = ?`,
          [
            attempt,
            now,
            jobId,
            input.claim?.claimGeneration ??
              input.knowledgeClaim?.claimGeneration ??
              input.authoringClaim!.claimGeneration,
          ],
        );
      }
      committing = true;
      await connection.commit();
      return { attemptId: attempt.toString('hex') };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      if (committing)
        throw new ConversationTurnJobError(
          'Model dispatch reservation needs reconciliation',
          'MODEL_DISPATCH_UNKNOWN',
        );
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
        throw new ConversationTurnJobError('Claim is stale', 'STALE_CLAIM');
      throw error;
    } finally {
      await connection.end();
    }
  }

  public async recordOutcome(
    attemptId: string,
    outcome: RecordedModelOutcome,
    now: Date,
    providerRequestId?: string,
  ): Promise<void> {
    validTime(now);
    const attempt = jobBytes(attemptId);
    if (
      !['succeeded', 'failed', 'unknown', 'not_dispatched'].includes(outcome) ||
      (providerRequestId !== undefined && !/^[A-Za-z0-9._:/-]{1,200}$/u.test(providerRequestId))
    )
      throw new ConversationTurnJobError();
    await this.#transaction(async (connection) => {
      // Global lock order is job -> attempt, also used by lease recovery.
      // This first read holds no lock; the attempt is immutable in its job link.
      const [links] = await connection.execute<(RowDataPacket & { job_id: Buffer | null })[]>(
        `SELECT job_id FROM model_call_attempt WHERE id = ?`,
        [attempt],
      );
      if (!links[0]) throw new ConversationTurnJobError('Model attempt is unavailable');
      if (links[0].job_id)
        await connection.execute(`SELECT id FROM job WHERE id = ? FOR UPDATE`, [links[0].job_id]);
      const [rows] = await connection.execute<
        (RowDataPacket & {
          state: string;
          job_id: Buffer | null;
          claim_generation: string | null;
        })[]
      >(
        `SELECT state, job_id, CAST(claim_generation AS CHAR) claim_generation FROM model_call_attempt WHERE id = ? FOR UPDATE`,
        [attempt],
      );
      const row = rows[0];
      if (!row) throw new ConversationTurnJobError('Model attempt is unavailable');
      // Late errors cannot overwrite a known result. A verified late response can resolve unknown.
      if (row.state !== 'dispatched' && row.state !== 'unknown') return;
      if (row.state === 'unknown' && outcome === 'not_dispatched') return;
      await connection.execute(
        `UPDATE model_call_attempt SET state = ?, provider_request_id = COALESCE(?, provider_request_id),
        updated_at = ?, completed_at = ? WHERE id = ?`,
        [outcome, providerRequestId ?? null, now, now, attempt],
      );
      if (row.job_id)
        await connection.execute(
          `UPDATE job SET model_outcome = ?, updated_at = ?
        WHERE id = ? AND claim_generation = ? AND model_attempt_id = ?`,
          [outcome, now, row.job_id, row.claim_generation, attempt],
        );
    });
  }

  public async unknownRiskCount(): Promise<number> {
    const connection = await this.database.openConnection();
    try {
      const [rows] = await connection.execute<(RowDataPacket & { total: string | number })[]>(
        `SELECT COUNT(*) total FROM model_call_attempt WHERE state IN ('dispatched', 'unknown')`,
      );
      const total = Number(rows[0]?.total);
      if (!Number.isSafeInteger(total) || total < 0) throw new ConversationTurnJobError();
      return total;
    } finally {
      await connection.end();
    }
  }

  async #transaction<T>(action: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.database.openConnection();
    try {
      await connection.beginTransaction();
      try {
        const result = await action(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    } finally {
      await connection.end();
    }
  }
}
