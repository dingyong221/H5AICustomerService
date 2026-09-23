import { createHash, createHmac, randomBytes } from 'node:crypto';

import type { Connection, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';

type ExistingRow = RowDataPacket & {
  release_id: Buffer;
  created_at: Date;
  expires_at: Date;
  status: string;
};

type TargetRow = RowDataPacket & {
  assistant_id: Buffer;
  merchant_id: Buffer;
  release_id: Buffer;
};

type SessionRow = RowDataPacket & {
  merchant_id: Buffer;
  assistant_id: Buffer;
  release_id: Buffer;
  expires_at: Date;
  config_snapshot: string | Record<string, unknown>;
};

type ActiveSessionRow = RowDataPacket & {
  merchant_id: Buffer;
  assistant_id: Buffer;
  release_id: Buffer;
  active_turn_id: Buffer | null;
  next_sequence: number;
};

type TurnMessageRow = RowDataPacket & {
  id: Buffer;
  seq_no: number;
  role: string;
  state: string;
  client_request_id: string | null;
  content: string;
  error_code: string | null;
  created_at: Date;
  turn_id: Buffer;
};

export type PublicSessionCreated = Readonly<{
  sessionHandle: string;
  releaseRef: string;
  state: 'active';
  createdAt: string;
}>;

export type PublicSessionContext = Readonly<{
  sessionId: string;
  merchantId: string;
  assistantId: string;
  releaseId: string;
  expiresAt: Date;
  configSnapshot: Readonly<Record<string, unknown>>;
}>;

export type PublicTurnAccepted = Readonly<{ turnId: string; traceId: string }>;
export type PublicTurnMessage = Readonly<{
  messageId: string;
  sequence: number;
  role: 'visitor' | 'assistant';
  content: string;
  createdAt: string;
  clientMessageId?: string;
}>;
export type PublicTurnResult = Readonly<{
  sessionHandle: string;
  turnId: string;
  traceId: string;
  state: 'accepted' | 'processing' | 'completed' | 'failed';
  messages: readonly PublicTurnMessage[];
  error?: Readonly<{ code: string; retryable: boolean }>;
}>;

export class PublicSessionUnavailableError extends Error {
  public constructor() {
    super('Public assistant session is unavailable');
    this.name = 'PublicSessionUnavailableError';
  }
}

export class PublicTurnConflictError extends Error {
  public constructor(public readonly code: 'TURN_IN_PROGRESS' | 'IDEMPOTENCY_KEY_REUSED') {
    super(code);
    this.name = 'PublicTurnConflictError';
  }
}

const isDuplicateKey = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062;
};

const binaryId = (value: Buffer): string => {
  if (!Buffer.isBuffer(value) || value.byteLength !== 16) throw new PublicSessionUnavailableError();
  return value.toString('hex');
};

const validNonce = (value: string): Buffer => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new PublicSessionUnavailableError();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    throw new PublicSessionUnavailableError();
  }
  return decoded;
};

const parseConfig = (value: string | Record<string, unknown>): Readonly<Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new PublicSessionUnavailableError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PublicSessionUnavailableError();
  }
  return parsed as Record<string, unknown>;
};

const handleParts = (sessionHandle: string): { sessionId: Buffer; credential: Buffer } | null => {
  const match = /^s_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/u.exec(sessionHandle);
  if (!match) return null;
  const credential = Buffer.from(match[2]!, 'base64url');
  if (credential.byteLength !== 32 || credential.toString('base64url') !== match[2]) return null;
  return { sessionId: Buffer.from(match[1]!, 'hex'), credential };
};

const turnIdBuffer = (turnId: string): Buffer | null =>
  /^t_[0-9a-f]{32}$/u.test(turnId) ? Buffer.from(turnId.slice(2), 'hex') : null;

const turnRef = (turnId: Buffer): string => `t_${binaryId(turnId)}`;
const traceRef = (turnId: Buffer): string => `trace_${binaryId(turnId)}`;

export class MySqlPublicSessionRepository {
  readonly #database: DatabaseConnectionConfig;
  readonly #key: Buffer;

  public constructor(database: DatabaseConnectionConfig, keyText: string) {
    if (!/^[A-Za-z0-9_-]{43,}$/u.test(keyText)) throw new PublicSessionUnavailableError();
    const key = Buffer.from(keyText, 'base64url');
    if (key.byteLength < 32 || key.toString('base64url') !== keyText) {
      throw new PublicSessionUnavailableError();
    }
    this.#database = database;
    this.#key = key;
  }

  #hmac(label: string, value: Buffer | string): Buffer {
    return createHmac('sha256', this.#key).update(label, 'ascii').update(value).digest();
  }

  #credentialId(secret: Buffer): Buffer {
    return this.#hmac('visitor-credential-v1:', secret).subarray(0, 16);
  }

  public async createSession(input: {
    publicSlug: string;
    sessionRequestId: string;
    visitorNonce: string;
    now: Date;
  }): Promise<PublicSessionCreated> {
    if (
      !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.publicSlug) ||
      !/^session_request_[0-9a-f]{32}$/u.test(input.sessionRequestId) ||
      !Number.isFinite(input.now.getTime())
    ) throw new PublicSessionUnavailableError();
    const nonce = validNonce(input.visitorNonce);
    const scope = Buffer.concat([
      nonce,
      Buffer.from(`:${input.publicSlug}:${input.sessionRequestId}`, 'utf8'),
    ]);
    const sessionId = this.#hmac('public-session-id-v1:', scope).subarray(0, 16);
    const visitorSecret = this.#hmac('public-session-secret-v1:', scope);
    const visitorCredentialId = this.#credentialId(visitorSecret);
    const sessionHandle = `s_${sessionId.toString('hex')}_${visitorSecret.toString('base64url')}`;
    const slugDigest = createHash('sha256').update(input.publicSlug, 'utf8').digest();

    const readExisting = async (connection: Connection, lock: boolean): Promise<ExistingRow | null> => {
      const [rows] = await connection.execute<ExistingRow[]>(
        `SELECT cs.release_id, cs.created_at, cs.expires_at, cs.status
           FROM conversation_session cs
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant m ON m.id = cs.merchant_id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND a.public_slug_digest = ? AND a.public_slug = ?
            AND a.status = 'active' AND m.status = 'active'
          LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
        [sessionId, visitorCredentialId, slugDigest, input.publicSlug],
      );
      return rows[0] ?? null;
    };
    const responseFrom = (row: ExistingRow): PublicSessionCreated => {
      if (row.status !== 'active' || row.expires_at.getTime() <= input.now.getTime()) {
        throw new PublicSessionUnavailableError();
      }
      return {
        sessionHandle,
        releaseRef: binaryId(row.release_id),
        state: 'active',
        createdAt: row.created_at.toISOString(),
      };
    };

    try {
      return await this.#withTransaction(async (connection) => {
        const existing = await readExisting(connection, true);
        if (existing) return responseFrom(existing);
        const [targets] = await connection.execute<TargetRow[]>(
          `SELECT a.id AS assistant_id, a.merchant_id, r.id AS release_id
             FROM assistant a
             JOIN merchant m ON m.id = a.merchant_id
             JOIN assistant_active_release ar
               ON ar.merchant_id = a.merchant_id AND ar.assistant_id = a.id
              AND ar.release_id = a.active_release_id
             JOIN assistant_release r
               ON r.merchant_id = ar.merchant_id AND r.assistant_id = ar.assistant_id
              AND r.id = ar.release_id
            WHERE a.public_slug_digest = ? AND a.public_slug = ?
              AND a.status = 'active' AND m.status = 'active' AND r.status = 'active'
            LIMIT 1 FOR UPDATE`,
          [slugDigest, input.publicSlug],
        );
        const target = targets[0];
        if (!target) throw new PublicSessionUnavailableError();
        const expiresAt = new Date(input.now.getTime() + 30 * 60 * 1_000);
        await connection.execute(
          `INSERT INTO conversation_session
             (id, merchant_id, assistant_id, release_id, visitor_credential_id, status,
              next_sequence, active_turn_id, version, last_activity_at, expires_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', 1, NULL, 1, ?, ?, ?, ?)`,
          [
            sessionId,
            target.merchant_id,
            target.assistant_id,
            target.release_id,
            visitorCredentialId,
            input.now,
            expiresAt,
            input.now,
            input.now,
          ],
        );
        return {
          sessionHandle,
          releaseRef: binaryId(target.release_id),
          state: 'active',
          createdAt: input.now.toISOString(),
        };
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const connection = await this.#database.openConnection();
      try {
        const existing = await readExisting(connection, false);
        if (!existing) throw new PublicSessionUnavailableError();
        return responseFrom(existing);
      } finally {
        await connection.end();
      }
    }
  }

  public async resolveSession(sessionHandle: string, now: Date): Promise<PublicSessionContext | null> {
    const handle = handleParts(sessionHandle);
    if (!handle || !Number.isFinite(now.getTime())) return null;
    const connection = await this.#database.openConnection();
    try {
      const [rows] = await connection.execute<SessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id, cs.release_id, cs.expires_at,
                r.config_snapshot
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN assistant_release r
             ON r.merchant_id = cs.merchant_id AND r.assistant_id = cs.assistant_id
            AND r.id = cs.release_id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND cs.status = 'active' AND cs.expires_at > ?
            AND m.status = 'active' AND a.status = 'active'
          LIMIT 1`,
        [handle.sessionId, this.#credentialId(handle.credential), now],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        sessionId: handle.sessionId.toString('hex'),
        merchantId: binaryId(row.merchant_id),
        assistantId: binaryId(row.assistant_id),
        releaseId: binaryId(row.release_id),
        expiresAt: row.expires_at,
        configSnapshot: parseConfig(row.config_snapshot),
      };
    } finally {
      await connection.end();
    }
  }

  public async acceptTurn(input: {
    sessionHandle: string;
    clientMessageId: string;
    content: string;
    now: Date;
  }): Promise<PublicTurnAccepted> {
    const handle = handleParts(input.sessionHandle);
    if (
      !handle || !/^message_[0-9a-f]{32}$/u.test(input.clientMessageId) ||
      input.content.trim().length < 1 || input.content.length > 2_000 ||
      !Number.isFinite(input.now.getTime())
    ) throw new PublicSessionUnavailableError();
    return this.#withTransaction(async (connection) => {
      const [sessions] = await connection.execute<ActiveSessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id, cs.release_id,
                cs.active_turn_id, cs.next_sequence
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND cs.status = 'active' AND cs.expires_at > ?
            AND m.status = 'active' AND a.status = 'active'
          LIMIT 1 FOR UPDATE`,
        [handle.sessionId, this.#credentialId(handle.credential), input.now],
      );
      const session = sessions[0];
      if (!session) throw new PublicSessionUnavailableError();
      const [existing] = await connection.execute<TurnMessageRow[]>(
        `SELECT turn_id, content FROM message
          WHERE merchant_id = ? AND assistant_id = ? AND session_id = ?
            AND client_request_id = ? AND role = 'visitor' LIMIT 1`,
        [session.merchant_id, session.assistant_id, handle.sessionId, input.clientMessageId],
      );
      if (existing[0]) {
        if (existing[0].content !== input.content) throw new PublicTurnConflictError('IDEMPOTENCY_KEY_REUSED');
        return { turnId: turnRef(existing[0].turn_id), traceId: traceRef(existing[0].turn_id) };
      }
      if (session.active_turn_id !== null) throw new PublicTurnConflictError('TURN_IN_PROGRESS');
      if (!Number.isSafeInteger(session.next_sequence) || session.next_sequence < 1 || session.next_sequence >= 4_294_967_295) {
        throw new PublicSessionUnavailableError();
      }
      const turnId = randomBytes(16);
      const messageId = randomBytes(16);
      const jobId = randomBytes(16);
      const expiresAt = new Date(input.now.getTime() + 30 * 60 * 1_000);
      await connection.execute(
        `INSERT INTO message
           (id, merchant_id, assistant_id, session_id, turn_id, seq_no,
            role, state, client_request_id, content, error_code, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'visitor', 'accepted', ?, ?, NULL, ?, NULL)`,
        [messageId, session.merchant_id, session.assistant_id, handle.sessionId,
          turnId, session.next_sequence, input.clientMessageId, input.content, input.now],
      );
      await connection.execute(
        `UPDATE conversation_session
            SET active_turn_id = ?, next_sequence = ?, last_activity_at = ?,
                expires_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND merchant_id = ? AND assistant_id = ?`,
        [turnId, session.next_sequence + 1, input.now, expiresAt, input.now,
          handle.sessionId, session.merchant_id, session.assistant_id],
      );
      await connection.execute(
        `INSERT INTO job
           (id, merchant_id, type, dedup_key, payload, state, priority,
            attempt, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, 'conversation.turn', ?, ?, 'pending', 0, 0, 5, ?, ?, ?)`,
        [jobId, session.merchant_id,
          createHash('sha256').update(handle.sessionId).update(turnId).digest(),
          JSON.stringify({ merchantId: binaryId(session.merchant_id), assistantId: binaryId(session.assistant_id),
            sessionId: handle.sessionId.toString('hex'), releaseId: binaryId(session.release_id),
            turnId: turnRef(turnId) }), input.now, input.now, input.now],
      );
      return { turnId: turnRef(turnId), traceId: traceRef(turnId) };
    });
  }

  public async readTurn(sessionHandle: string, turnId: string, now: Date): Promise<PublicTurnResult | null> {
    const handle = handleParts(sessionHandle);
    const turnBuffer = turnIdBuffer(turnId);
    if (!handle || !turnBuffer || !Number.isFinite(now.getTime())) return null;
    const connection = await this.#database.openConnection();
    try {
      const [sessions] = await connection.execute<ActiveSessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND cs.status = 'active' AND cs.expires_at > ?
            AND m.status = 'active' AND a.status = 'active' LIMIT 1`,
        [handle.sessionId, this.#credentialId(handle.credential), now],
      );
      const session = sessions[0];
      if (!session) return null;
      const [rows] = await connection.execute<TurnMessageRow[]>(
        `SELECT id, seq_no, role, state, client_request_id, content,
                error_code, created_at, turn_id
           FROM message
          WHERE merchant_id = ? AND assistant_id = ? AND session_id = ? AND turn_id = ?
          ORDER BY seq_no ASC LIMIT 2`,
        [session.merchant_id, session.assistant_id, handle.sessionId, turnBuffer],
      );
      const first = rows[0];
      if (!first || first.role !== 'visitor') return null;
      if (!['accepted', 'processing', 'completed', 'failed'].includes(first.state)) {
        throw new PublicSessionUnavailableError();
      }
      if (first.state === 'completed' && (rows[1]?.role !== 'assistant' || rows[1].state !== 'completed')) {
        throw new PublicSessionUnavailableError();
      }
      const messages: PublicTurnMessage[] = rows.map((row) => {
        if (row.role !== 'visitor' && row.role !== 'assistant') throw new PublicSessionUnavailableError();
        return {
          messageId: binaryId(row.id), sequence: row.seq_no, role: row.role,
          content: row.content, createdAt: row.created_at.toISOString(),
          ...(row.role === 'visitor' && row.client_request_id
            ? { clientMessageId: row.client_request_id } : {}),
        };
      });
      return {
        sessionHandle, turnId, traceId: traceRef(turnBuffer),
        state: first.state as PublicTurnResult['state'], messages,
        ...(first.state === 'failed'
          ? { error: { code: first.error_code ?? 'TURN_FAILED', retryable: false } } : {}),
      };
    } finally {
      await connection.end();
    }
  }

  async #withTransaction<TResult>(operation: (connection: Connection) => Promise<TResult>): Promise<TResult> {
    const connection = await this.#database.openConnection();
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
