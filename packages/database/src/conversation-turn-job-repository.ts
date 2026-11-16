import { randomBytes } from 'node:crypto';
import {
  lockRuntimeGate,
  assertRuntimeAllowed,
  probeRuntimeSchema,
  runtimeEligibleSql,
  runtimeControlEnabled,
} from './runtime-control-contract.js';
import { normalizeHumanContact } from '@h5cs/domain';

import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';
import {
  ConversationTurnJobError,
  conversationClaimIds,
  decodeConversationTaskPayload,
  jobBytes,
  lockValidConversationClaim,
  jobObject,
  type ClaimMutationResult,
  type ModelCallOutcome,
} from './conversation-job-contract.js';
export { ConversationTurnJobError } from './conversation-job-contract.js';

type JobRow = RowDataPacket & {
  id: Buffer;
  merchant_id: Buffer | null;
  payload: string | Record<string, unknown>;
  attempt: number;
  max_attempts: number;
  claim_generation: string;
  model_outcome: ModelCallOutcome;
  state: string;
};

type SessionRow = RowDataPacket & {
  merchant_id: Buffer;
  assistant_id: Buffer;
  release_id: Buffer;
  active_turn_id: Buffer | null;
  next_sequence: number;
  status: string;
  expires_at: Date;
  merchant_status: string;
  assistant_status: string;
  config_snapshot: string | Record<string, unknown>;
};

type MessageRow = RowDataPacket & {
  id: Buffer;
  seq_no: number;
  content: string;
  state: string;
};

type ContextRow = RowDataPacket & { role: string; content: string };

export type ConversationFacts = Readonly<{
  displayName: string;
  industry: string;
  businessScope: string;
  materialsSummary: string;
  pricingSummary: string;
  promotionSummary: string;
  insufficientInfoMessage: string;
  humanContact?: string;
}>;

export type ConversationTurnClaim = Readonly<{
  jobId: string;
  leaseOwner: string;
  claimGeneration: string;
  leaseUntil: Date;
  payloadVersion: 0 | 1;
  merchantId: string;
  assistantId: string;
  sessionId: string;
  releaseId: string;
  turnId: string;
  visitorMessageId: string;
  question: string;
  facts: ConversationFacts;
  context: readonly Readonly<{ role: 'visitor' | 'assistant'; content: string }>[];
}>;

const hex = (value: Buffer): string => {
  if (!Buffer.isBuffer(value) || value.byteLength !== 16) throw new ConversationTurnJobError();
  return value.toString('hex');
};

const parseObject = (value: string | Record<string, unknown>): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new ConversationTurnJobError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConversationTurnJobError();
  }
  return parsed as Record<string, unknown>;
};

const parsePayload = decodeConversationTaskPayload;

const factsFrom = (value: string | Record<string, unknown>): ConversationFacts => {
  const snapshot = parseObject(value);
  const fields = [
    'displayName',
    'industry',
    'businessScope',
    'materialsSummary',
    'pricingSummary',
    'promotionSummary',
    'insufficientInfoMessage',
  ] as const;
  for (const field of fields) {
    if (typeof snapshot[field] !== 'string' || snapshot[field].trim().length === 0) {
      throw new ConversationTurnJobError();
    }
  }
  const humanContact = normalizeHumanContact(snapshot['humanContact']);
  if (humanContact === null) throw new ConversationTurnJobError();
  return {
    ...Object.fromEntries(fields.map((field) => [field, snapshot[field]])),
    humanContact,
  } as ConversationFacts;
};

export class MySqlConversationTurnJobRepository {
  public constructor(private readonly database: DatabaseConnectionConfig) {}

  public async claimNext(
    now: Date,
    leaseOwner: string,
    options: { merchantId?: string } = {},
  ): Promise<ConversationTurnClaim | null> {
    if (!Number.isFinite(now.getTime()) || !/^[A-Za-z0-9_-]{8,128}$/u.test(leaseOwner)) {
      throw new ConversationTurnJobError();
    }
    return this.#withTransaction(async (connection) => {
      await lockRuntimeGate(connection);
      const [jobs] = await connection.execute<JobRow[]>(
        `SELECT id, merchant_id, payload, state, attempt, max_attempts,
                CAST(claim_generation AS CHAR) claim_generation, model_outcome
           FROM job
          WHERE type = 'conversation.turn'
            ${options.merchantId ? 'AND merchant_id = ?' : ''}
            AND ((state = 'pending' AND run_after <= ?)
              OR (state = 'processing' AND lease_until < ?))
          ${runtimeEligibleSql()}
          ORDER BY priority DESC, run_after ASC, id ASC
          LIMIT 1 ${runtimeControlEnabled() ? '' : 'FOR UPDATE SKIP LOCKED'}`,
        [...(options.merchantId ? [jobBytes(options.merchantId)] : []), now, now],
      );
      const job = jobs[0];
      if (!job) return null;
      if (runtimeControlEnabled()) {
        if (!job.merchant_id) throw new ConversationTurnJobError();
        await assertRuntimeAllowed(connection, {
          merchantId: hex(job.merchant_id),
          jobId: hex(job.id),
        });
        const [current] = await connection.execute<JobRow[]>(
          `SELECT id,merchant_id,payload,state,attempt,max_attempts,CAST(claim_generation AS CHAR) claim_generation,model_outcome FROM job WHERE id=? AND ((state='pending' AND run_after<=?) OR (state='processing' AND lease_until<?)) FOR UPDATE SKIP LOCKED`,
          [job.id, now, now],
        );
        if (!current[0] || !current[0].merchant_id?.equals(job.merchant_id)) return null;
        Object.assign(job, current[0]);
      }
      let payload: ReturnType<typeof parsePayload>;
      try {
        payload = parsePayload(job.payload);
      } catch (error) {
        const errorCode =
          error instanceof ConversationTurnJobError && error.code === 'UNSUPPORTED_JOB_VERSION'
            ? 'UNSUPPORTED_JOB_VERSION'
            : 'INVALID_JOB_PAYLOAD';
        // Known scope can be released even when the handler version is unsupported.
        // Never interpret that task's facts or call a supplier.
        try {
          const scoped = parsePayload({ ...jobObject(job.payload), schemaVersion: undefined });
          if (!job.merchant_id?.equals(scoped.merchantId)) throw new ConversationTurnJobError();
          await this.#failLocked(connection, job.id, scoped, now, errorCode);
        } catch (scopeError) {
          if (!(scopeError instanceof ConversationTurnJobError)) throw scopeError;
          await this.#rejectJob(connection, job.id, now, errorCode);
        }
        return null;
      }
      if (!job.merchant_id || !job.merchant_id.equals(payload.merchantId)) {
        await this.#rejectJob(connection, job.id, now, 'INVALID_JOB_SCOPE');
        return null;
      }
      if (
        job.state === 'processing' &&
        String(job.claim_generation) === '0' &&
        job.attempt > 0 &&
        job.model_outcome === 'none'
      ) {
        const attemptId = randomBytes(16);
        await connection.execute(
          `INSERT INTO model_call_attempt
          (id, merchant_id, job_id, claim_generation, operation, state, created_at, updated_at, completed_at)
          VALUES (?, ?, ?, 0, 'consumer', 'unknown', ?, ?, ?)`,
          [attemptId, job.merchant_id, job.id, now, now, now],
        );
        await connection.execute(
          `UPDATE job SET model_outcome = 'unknown', model_attempt_id = ? WHERE id = ?`,
          [attemptId, job.id],
        );
        job.model_outcome = 'unknown';
      }
      // A lease is not proof that a timed-out supplier request never ran.
      // Only claims with no dispatched attempt may be automatically recovered.
      if (job.model_outcome !== 'none' && job.model_outcome !== 'not_dispatched') {
        await connection.execute(
          `UPDATE model_call_attempt SET state = 'unknown', updated_at = ?, completed_at = ?
             WHERE job_id = ? AND claim_generation = ? AND state = 'dispatched'`,
          [now, now, job.id, job.claim_generation],
        );
        await connection.execute(
          `UPDATE job SET model_outcome = 'unknown' WHERE id = ? AND model_outcome = 'dispatched'`,
          [job.id],
        );
        await this.#failLocked(
          connection,
          job.id,
          payload,
          now,
          job.model_outcome === 'succeeded' ? 'TURN_RESULT_UNAVAILABLE' : 'MODEL_RESULT_UNKNOWN',
        );
        return null;
      }
      const [sessions] = await connection.execute<SessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id, cs.release_id, cs.active_turn_id,
                cs.next_sequence, cs.status, cs.expires_at,
                m.status AS merchant_status, a.status AS assistant_status, r.config_snapshot
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
           JOIN assistant_release r
             ON r.merchant_id = cs.merchant_id AND r.assistant_id = cs.assistant_id
            AND r.id = cs.release_id
          WHERE cs.id = ? AND cs.merchant_id = ? AND cs.assistant_id = ?
          LIMIT 1 FOR UPDATE`,
        [payload.sessionId, payload.merchantId, payload.assistantId],
      );
      const session = sessions[0];
      if (
        !session ||
        !session.release_id.equals(payload.releaseId) ||
        !session.active_turn_id?.equals(payload.turnId) ||
        session.status !== 'active' ||
        session.expires_at.getTime() <= now.getTime() ||
        session.merchant_status !== 'active' ||
        session.assistant_status !== 'active'
      ) {
        if (session) {
          await this.#failLocked(connection, job.id, payload, now, 'SESSION_UNAVAILABLE');
        } else {
          await this.#rejectJob(connection, job.id, now, 'SESSION_UNAVAILABLE');
        }
        return null;
      }
      const [messages] = await connection.execute<MessageRow[]>(
        `SELECT id, seq_no, content, state
           FROM message
          WHERE merchant_id = ? AND assistant_id = ? AND session_id = ?
            AND turn_id = ? AND role = 'visitor'
          LIMIT 1 FOR UPDATE`,
        [payload.merchantId, payload.assistantId, payload.sessionId, payload.turnId],
      );
      const message = messages[0];
      if (
        !message ||
        (message.state !== 'accepted' && message.state !== 'processing') ||
        !Number.isSafeInteger(session.next_sequence) ||
        session.next_sequence < 2
      ) {
        await this.#failLocked(connection, job.id, payload, now, 'MESSAGE_UNAVAILABLE');
        return null;
      }
      if (job.attempt >= job.max_attempts) {
        await this.#failLocked(connection, job.id, payload, now, 'TURN_ATTEMPTS_EXHAUSTED');
        return null;
      }
      let facts: ConversationFacts;
      try {
        facts = factsFrom(session.config_snapshot);
      } catch {
        await this.#failLocked(connection, job.id, payload, now, 'KNOWLEDGE_UNAVAILABLE');
        return null;
      }
      const [contextRows] = await connection.execute<ContextRow[]>(
        `SELECT role, content FROM message
          WHERE merchant_id = ? AND assistant_id = ? AND session_id = ?
            AND seq_no < ? AND state = 'completed'
          ORDER BY seq_no DESC LIMIT 24`,
        [payload.merchantId, payload.assistantId, payload.sessionId, message.seq_no],
      );
      if (contextRows.some((row) => row.role !== 'visitor' && row.role !== 'assistant')) {
        await this.#failLocked(connection, job.id, payload, now, 'CONTEXT_UNAVAILABLE');
        return null;
      }
      const context = contextRows.reverse().map((row) => ({
        role: row.role as 'visitor' | 'assistant',
        content: row.content,
      }));
      const leaseUntil = new Date(now.getTime() + 2 * 60 * 1_000);
      const [jobResult] = await connection.execute<ResultSetHeader>(
        `UPDATE job SET state = 'processing', attempt = attempt + 1,
            claim_generation = claim_generation + 1, model_outcome = 'none', model_attempt_id = NULL,
            lease_owner = ?, lease_until = ?, updated_at = ?
          WHERE id = ? AND type = 'conversation.turn'`,
        [leaseOwner, leaseUntil, now, job.id],
      );
      const [messageResult] = await connection.execute<ResultSetHeader>(
        `UPDATE message SET state = 'processing'
          WHERE id = ? AND merchant_id = ? AND assistant_id = ? AND session_id = ?
            AND turn_id = ? AND state IN ('accepted', 'processing')`,
        [message.id, payload.merchantId, payload.assistantId, payload.sessionId, payload.turnId],
      );
      if (jobResult.affectedRows !== 1 || messageResult.affectedRows !== 1) {
        throw new ConversationTurnJobError();
      }
      return {
        jobId: hex(job.id),
        leaseOwner,
        claimGeneration: (BigInt(job.claim_generation) + 1n).toString(),
        leaseUntil,
        payloadVersion: payload.payloadVersion,
        merchantId: hex(payload.merchantId),
        assistantId: hex(payload.assistantId),
        sessionId: hex(payload.sessionId),
        releaseId: hex(payload.releaseId),
        turnId: hex(payload.turnId),
        visitorMessageId: hex(message.id),
        question: message.content,
        facts,
        context,
      };
    });
  }

  public async complete(
    claim: ConversationTurnClaim,
    answer: string,
    now: Date,
  ): Promise<ClaimMutationResult> {
    if (answer.trim().length === 0 || answer.length > 8_000 || !Number.isFinite(now.getTime())) {
      throw new ConversationTurnJobError();
    }
    return this.#withTransaction(async (connection) => {
      const locked = await lockValidConversationClaim(connection, claim, now);
      if (!locked) return 'stale';
      const payload = locked.ids;
      const [sessions] = await connection.execute<
        (RowDataPacket & {
          active_turn_id: Buffer | null;
          next_sequence: number;
          merchant_status: string;
          assistant_status: string;
        })[]
      >(
        `SELECT cs.active_turn_id, cs.next_sequence,
                m.status AS merchant_status, a.status AS assistant_status
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
          WHERE cs.id = ? AND cs.merchant_id = ? AND cs.assistant_id = ?
            AND cs.release_id = ? AND cs.status = 'active' AND cs.expires_at > ? LIMIT 1 FOR UPDATE`,
        [payload.sessionId, payload.merchantId, payload.assistantId, payload.releaseId, now],
      );
      const session = sessions[0];
      if (
        !session?.active_turn_id?.equals(payload.turnId) ||
        session.merchant_status !== 'active' ||
        session.assistant_status !== 'active' ||
        !Number.isSafeInteger(session.next_sequence) ||
        session.next_sequence >= 4_294_967_295
      ) {
        return 'stale';
      }
      const assistantMessageId = randomBytes(16);
      await connection.execute(
        `INSERT INTO message
           (id, merchant_id, assistant_id, session_id, turn_id, seq_no,
            role, state, client_request_id, content, error_code, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'assistant', 'completed', NULL, ?, NULL, ?, ?)`,
        [
          assistantMessageId,
          payload.merchantId,
          payload.assistantId,
          payload.sessionId,
          payload.turnId,
          session.next_sequence,
          answer,
          now,
          now,
        ],
      );
      const [visitorResult] = await connection.execute<ResultSetHeader>(
        `UPDATE message SET state = 'completed', completed_at = ?
          WHERE id = ? AND merchant_id = ? AND assistant_id = ? AND session_id = ?
            AND turn_id = ? AND role = 'visitor' AND state = 'processing'`,
        [
          now,
          payload.visitorMessageId,
          payload.merchantId,
          payload.assistantId,
          payload.sessionId,
          payload.turnId,
        ],
      );
      const [sessionResult] = await connection.execute<ResultSetHeader>(
        `UPDATE conversation_session SET active_turn_id = NULL, next_sequence = ?,
            last_activity_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND merchant_id = ? AND assistant_id = ? AND active_turn_id = ?`,
        [
          session.next_sequence + 1,
          now,
          now,
          payload.sessionId,
          payload.merchantId,
          payload.assistantId,
          payload.turnId,
        ],
      );
      const [jobResult] = await connection.execute<ResultSetHeader>(
        `UPDATE job SET state = 'completed', lease_owner = NULL, lease_until = NULL,
            updated_at = ?, completed_at = ?
          WHERE id = ? AND merchant_id = ? AND state = 'processing' AND lease_owner = ?
            AND claim_generation = ? AND lease_until > ?`,
        [now, now, payload.jobId, payload.merchantId, claim.leaseOwner, claim.claimGeneration, now],
      );
      if (
        visitorResult.affectedRows !== 1 ||
        sessionResult.affectedRows !== 1 ||
        jobResult.affectedRows !== 1
      )
        throw new ConversationTurnJobError();
      return 'applied';
    });
  }

  public async fail(
    claim: ConversationTurnClaim,
    errorCode: string,
    now: Date,
  ): Promise<ClaimMutationResult> {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(errorCode) || !Number.isFinite(now.getTime())) {
      throw new ConversationTurnJobError();
    }
    return this.#withTransaction(async (connection) => {
      const locked = await lockValidConversationClaim(connection, claim, now);
      if (!locked) return 'stale';
      await this.#failLocked(connection, locked.ids.jobId, locked.ids, now, errorCode);
      return 'applied';
    });
  }

  public async cancel(claim: ConversationTurnClaim, now: Date): Promise<ClaimMutationResult> {
    return this.#withTransaction(async (connection) => {
      const locked = await lockValidConversationClaim(connection, claim, now);
      if (!locked) return 'stale';
      await this.#failLocked(connection, locked.ids.jobId, locked.ids, now, 'TURN_CANCELLED');
      await connection.execute(`UPDATE job SET state = 'cancelled' WHERE id = ?`, [
        locked.ids.jobId,
      ]);
      return 'applied';
    });
  }

  public async releaseBeforeDispatch(
    claim: ConversationTurnClaim,
    now: Date,
    options?: { reason: 'runtime_paused' },
  ): Promise<ClaimMutationResult> {
    return this.#withTransaction(async (connection) => {
      const locked = await lockValidConversationClaim(connection, claim, now);
      if (!locked || !['none', 'not_dispatched'].includes(locked.job.model_outcome)) return 'stale';
      if (options?.reason === 'runtime_paused' && locked.job.model_outcome !== 'none')
        return 'stale';
      await connection.execute(
        `UPDATE job SET state = 'pending', lease_owner = NULL, lease_until = NULL,
            run_after = ?, updated_at = ? ${options?.reason === 'runtime_paused' ? ',attempt=GREATEST(attempt,1)-1' : ''} WHERE id = ?`,
        [now, now, locked.ids.jobId],
      );
      return 'applied';
    });
  }

  public async reconcile(claim: ConversationTurnClaim): Promise<{
    state: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'missing';
    currentGeneration: string | null;
    modelOutcome: ModelCallOutcome;
  }> {
    const ids = conversationClaimIds(claim);
    const connection = await this.database.openConnection();
    try {
      const [rows] = await connection.execute<
        (RowDataPacket & {
          state: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
          claim_generation: string;
          model_outcome: ModelCallOutcome;
          payload: string | Record<string, unknown>;
        })[]
      >(
        `SELECT state, CAST(claim_generation AS CHAR) claim_generation, model_outcome, payload
        FROM job WHERE id = ? AND merchant_id = ? AND type = 'conversation.turn'`,
        [ids.jobId, ids.merchantId],
      );
      const row = rows[0];
      if (!row) return { state: 'missing', currentGeneration: null, modelOutcome: 'none' };
      const stored = parsePayload(row.payload);
      if (
        !stored.merchantId.equals(ids.merchantId) ||
        !stored.assistantId.equals(ids.assistantId) ||
        !stored.sessionId.equals(ids.sessionId) ||
        !stored.releaseId.equals(ids.releaseId) ||
        !stored.turnId.equals(ids.turnId)
      )
        return { state: 'missing', currentGeneration: null, modelOutcome: 'none' };
      return {
        state: row.state,
        currentGeneration: String(row.claim_generation),
        modelOutcome: row.model_outcome,
      };
    } finally {
      await connection.end();
    }
  }

  public async listRunnableMerchantHeads(
    now: Date,
    options: { limit?: number; afterMerchantId?: string } = {},
  ) {
    const limit = options.limit ?? 64;
    if (!Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 256)
      throw new ConversationTurnJobError();
    const connection = await this.database.openConnection();
    try {
      await probeRuntimeSchema(connection);
      const [rows] = await connection.execute<
        (RowDataPacket & { merchant_id: Buffer; oldest_ready_at: Date })[]
      >(
        // These aggregate fields deliberately reference every runtime job
        // column even on an empty queue, so an old schema fails before claim.
        `SELECT merchant_id, MIN(run_after) oldest_ready_at,
                MAX(claim_generation) runtime_generation,
                MAX(model_outcome) runtime_outcome,
                COUNT(model_attempt_id) runtime_attempt_count FROM job
          WHERE type = 'conversation.turn' AND merchant_id IS NOT NULL
            ${options.afterMerchantId ? 'AND merchant_id > ?' : ''}
            AND ((state = 'pending' AND run_after <= ?) OR (state = 'processing' AND lease_until < ?))
          ${runtimeEligibleSql()} GROUP BY merchant_id ORDER BY merchant_id ASC LIMIT ${limit}`,
        [...(options.afterMerchantId ? [jobBytes(options.afterMerchantId)] : []), now, now],
      );
      return rows.map((row) => ({
        merchantId: hex(row.merchant_id),
        oldestReadyAt: row.oldest_ready_at,
      }));
    } finally {
      await connection.end();
    }
  }

  async #rejectJob(
    connection: Connection,
    jobId: Buffer,
    now: Date,
    errorCode: string,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE job SET state = 'failed', last_error_code = ?, lease_owner = NULL,
          lease_until = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
      [errorCode, now, now, jobId],
    );
    if (result.affectedRows !== 1) throw new ConversationTurnJobError();
  }

  async #failLocked(
    connection: Connection,
    jobId: Buffer,
    ids: { merchantId: Buffer; assistantId: Buffer; sessionId: Buffer; turnId: Buffer },
    now: Date,
    errorCode: string,
  ): Promise<void> {
    await connection.execute(
      `UPDATE message SET state = 'failed', error_code = ?, completed_at = ?
        WHERE merchant_id = ? AND assistant_id = ? AND session_id = ?
          AND turn_id = ? AND role = 'visitor' AND state IN ('accepted', 'processing')`,
      [errorCode, now, ids.merchantId, ids.assistantId, ids.sessionId, ids.turnId],
    );
    await connection.execute(
      `UPDATE conversation_session SET active_turn_id = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND merchant_id = ? AND assistant_id = ? AND active_turn_id = ?`,
      [now, ids.sessionId, ids.merchantId, ids.assistantId, ids.turnId],
    );
    await this.#rejectJob(connection, jobId, now, errorCode);
  }

  async #withTransaction<TResult>(
    operation: (connection: Connection) => Promise<TResult>,
  ): Promise<TResult> {
    const connection = await this.database.openConnection();
    try {
      await connection.beginTransaction();
      try {
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      await connection.end();
    }
  }
}
