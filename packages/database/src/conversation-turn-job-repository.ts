import { randomBytes } from 'node:crypto';
import { normalizeHumanContact } from '@h5cs/domain';

import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';

type JobRow = RowDataPacket & {
  id: Buffer;
  merchant_id: Buffer | null;
  payload: string | Record<string, unknown>;
  attempt: number;
  max_attempts: number;
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

export class ConversationTurnJobError extends Error {
  public constructor(message = 'Conversation turn job is unavailable') {
    super(message);
    this.name = 'ConversationTurnJobError';
  }
}

const hex = (value: Buffer): string => {
  if (!Buffer.isBuffer(value) || value.byteLength !== 16) throw new ConversationTurnJobError();
  return value.toString('hex');
};

const bytes = (value: string): Buffer => {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new ConversationTurnJobError();
  return Buffer.from(value, 'hex');
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

const parsePayload = (value: string | Record<string, unknown>) => {
  const payload = parseObject(value);
  const names = ['merchantId', 'assistantId', 'sessionId', 'releaseId'] as const;
  for (const name of names)
    if (typeof payload[name] !== 'string') throw new ConversationTurnJobError();
  if (typeof payload['turnId'] !== 'string' || !/^t_[0-9a-f]{32}$/u.test(payload['turnId'])) {
    throw new ConversationTurnJobError();
  }
  return {
    merchantId: bytes(payload['merchantId'] as string),
    assistantId: bytes(payload['assistantId'] as string),
    sessionId: bytes(payload['sessionId'] as string),
    releaseId: bytes(payload['releaseId'] as string),
    turnId: bytes((payload['turnId'] as string).slice(2)),
  };
};

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

  public async claimNext(now: Date, leaseOwner: string): Promise<ConversationTurnClaim | null> {
    if (!Number.isFinite(now.getTime()) || !/^[A-Za-z0-9_-]{8,128}$/u.test(leaseOwner)) {
      throw new ConversationTurnJobError();
    }
    return this.#withTransaction(async (connection) => {
      const [jobs] = await connection.execute<JobRow[]>(
        `SELECT id, merchant_id, payload, attempt, max_attempts
           FROM job
          WHERE type = 'conversation.turn'
            AND ((state = 'pending' AND run_after <= ?)
              OR (state = 'processing' AND lease_until < ?))
          ORDER BY priority DESC, run_after ASC, id ASC
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now, now],
      );
      const job = jobs[0];
      if (!job) return null;
      let payload: ReturnType<typeof parsePayload>;
      try {
        payload = parsePayload(job.payload);
      } catch {
        await this.#rejectJob(connection, job.id, now, 'INVALID_JOB_PAYLOAD');
        return null;
      }
      if (!job.merchant_id || !job.merchant_id.equals(payload.merchantId)) {
        await this.#rejectJob(connection, job.id, now, 'INVALID_JOB_SCOPE');
        return null;
      }
      const [sessions] = await connection.execute<SessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id, cs.release_id, cs.active_turn_id,
                cs.next_sequence, cs.status, cs.expires_at,
                m.status AS merchant_status, a.status AS assistant_status, r.config_snapshot
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
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
          ORDER BY seq_no DESC LIMIT 10`,
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

  public async complete(claim: ConversationTurnClaim, answer: string, now: Date): Promise<void> {
    if (answer.trim().length === 0 || answer.length > 8_000 || !Number.isFinite(now.getTime())) {
      throw new ConversationTurnJobError();
    }
    await this.#withTransaction(async (connection) => {
      const payload = this.#claimIds(claim);
      const [jobs] = await connection.execute<(RowDataPacket & { id: Buffer })[]>(
        `SELECT id FROM job WHERE id = ? AND type = 'conversation.turn'
            AND state = 'processing' AND lease_owner = ? AND lease_until > ?
          LIMIT 1 FOR UPDATE`,
        [payload.jobId, claim.leaseOwner, now],
      );
      if (!jobs[0]) throw new ConversationTurnJobError();
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
          WHERE cs.id = ? AND cs.merchant_id = ? AND cs.assistant_id = ?
            AND cs.release_id = ? AND cs.status = 'active' LIMIT 1 FOR UPDATE`,
        [payload.sessionId, payload.merchantId, payload.assistantId, payload.releaseId],
      );
      const session = sessions[0];
      if (
        !session?.active_turn_id?.equals(payload.turnId) ||
        session.merchant_status !== 'active' ||
        session.assistant_status !== 'active' ||
        !Number.isSafeInteger(session.next_sequence) ||
        session.next_sequence >= 4_294_967_295
      ) {
        throw new ConversationTurnJobError();
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
          WHERE id = ? AND state = 'processing' AND lease_owner = ?`,
        [now, now, payload.jobId, claim.leaseOwner],
      );
      if (
        visitorResult.affectedRows !== 1 ||
        sessionResult.affectedRows !== 1 ||
        jobResult.affectedRows !== 1
      )
        throw new ConversationTurnJobError();
    });
  }

  public async fail(claim: ConversationTurnClaim, errorCode: string, now: Date): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(errorCode) || !Number.isFinite(now.getTime())) {
      throw new ConversationTurnJobError();
    }
    await this.#withTransaction(async (connection) => {
      const payload = this.#claimIds(claim);
      const [jobs] = await connection.execute<(RowDataPacket & { id: Buffer })[]>(
        `SELECT id FROM job WHERE id = ? AND type = 'conversation.turn'
            AND state = 'processing' AND lease_owner = ? AND lease_until > ?
          LIMIT 1 FOR UPDATE`,
        [payload.jobId, claim.leaseOwner, now],
      );
      if (!jobs[0]) throw new ConversationTurnJobError();
      await this.#failLocked(connection, payload.jobId, payload, now, errorCode);
    });
  }

  #claimIds(claim: ConversationTurnClaim) {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(claim.leaseOwner)) throw new ConversationTurnJobError();
    return {
      jobId: bytes(claim.jobId),
      merchantId: bytes(claim.merchantId),
      assistantId: bytes(claim.assistantId),
      sessionId: bytes(claim.sessionId),
      releaseId: bytes(claim.releaseId),
      turnId: bytes(claim.turnId),
      visitorMessageId: bytes(claim.visitorMessageId),
    };
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
