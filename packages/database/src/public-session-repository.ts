import { createHash, createHmac, randomBytes } from 'node:crypto';
import { normalizeHumanContact } from '@h5cs/domain';

import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

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

type HistorySessionRow = RowDataPacket & {
  merchant_id: Buffer;
  assistant_id: Buffer;
  release_id: Buffer;
  created_at: Date;
  active_turn_id: Buffer | null;
  public_slug: string;
  merchant_name: string;
  config_snapshot: string | Record<string, unknown>;
};

type HistoryMessageRow = RowDataPacket & {
  id: Buffer;
  turn_id: Buffer;
  seq_no: number;
  role: string;
  state: string;
  client_request_id: string | null;
  content: string;
  created_at: Date;
};

type SessionMaterial = Readonly<{
  sessionId: Buffer;
  visitorCredentialId: Buffer;
  sessionHandle: string;
  slugDigest: Buffer;
}>;

type ActiveSessionRow = RowDataPacket & {
  merchant_id: Buffer;
  assistant_id: Buffer;
  release_id: Buffer;
  active_turn_id: Buffer | null;
  next_sequence: number;
};

type EndSessionRow = RowDataPacket & {
  status: string;
  active_turn_id: Buffer | null;
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

export type PublicSessionEnded = Readonly<{ sessionHandle: string; state: 'ended' }>;

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

export type PublicSessionHistory = Readonly<{
  sessionHandle: string;
  releaseRef: string;
  createdAt: string;
  snapshot: Readonly<{
    publicAssistantId: string;
    merchantDisplayName: string;
    assistantDisplayName: string;
    aiDisclosure: true;
    businessScope: string;
    welcomeMessage: string;
    humanContact: string;
    availability: 'online';
    releaseRef: string;
  }>;
  messages: readonly PublicTurnMessage[];
  activeTurn: Readonly<{
    turnId: string;
    clientMessageId: string;
    content: string;
  }> | null;
  hasEarlierMessages: boolean;
}>;

export class PublicSessionUnavailableError extends Error {
  public constructor() {
    super('Public assistant session is unavailable');
    this.name = 'PublicSessionUnavailableError';
  }
}

export class PublicReleaseWithdrawnError extends Error {
  public constructor() {
    super('RELEASE_WITHDRAWN');
    this.name = 'PublicReleaseWithdrawnError';
  }
}

async function assertNotWithdrawn(connection: Connection, sessionId: Buffer, visitorId: Buffer) {
  const [rows] = await connection.execute<(RowDataPacket & { status: string })[]>(
    `SELECT status FROM conversation_session WHERE id=? AND visitor_credential_id=? LIMIT 1`,
    [sessionId, visitorId],
  );
  if (rows[0]?.status === 'withdrawn') throw new PublicReleaseWithdrawnError();
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

const parseConfig = (
  value: string | Record<string, unknown>,
): Readonly<Record<string, unknown>> => {
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

const publicText = (value: unknown, max: number): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new PublicSessionUnavailableError();
  return value;
};

const publicParagraph = (value: unknown, max: number): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max ||
    /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value)
  )
    throw new PublicSessionUnavailableError();
  return value;
};

const handleParts = (sessionHandle: string): Buffer | null => {
  const match = /^s_([0-9a-f]{32})$/u.exec(sessionHandle);
  return match ? Buffer.from(match[1]!, 'hex') : null;
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

  #credentialId(nonce: Buffer): Buffer {
    return this.#hmac('visitor-credential-v2:', nonce).subarray(0, 16);
  }

  #authorizedHandle(
    sessionHandle: string,
    visitorNonce: string,
  ): { sessionId: Buffer; visitorCredentialId: Buffer } | null {
    const sessionId = handleParts(sessionHandle);
    if (!sessionId) return null;
    try {
      return { sessionId, visitorCredentialId: this.#credentialId(validNonce(visitorNonce)) };
    } catch {
      return null;
    }
  }

  #material(publicSlug: string, sessionRequestId: string, visitorNonce: string): SessionMaterial {
    if (
      !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(publicSlug) ||
      !/^session_request_[0-9a-f]{32}$/u.test(sessionRequestId)
    ) {
      throw new PublicSessionUnavailableError();
    }
    const nonce = validNonce(visitorNonce);
    const scope = Buffer.concat([nonce, Buffer.from(`:${publicSlug}:${sessionRequestId}`, 'utf8')]);
    const sessionId = this.#hmac('public-session-id-v1:', scope).subarray(0, 16);
    return {
      sessionId,
      visitorCredentialId: this.#credentialId(nonce),
      sessionHandle: `s_${sessionId.toString('hex')}`,
      slugDigest: createHash('sha256').update(publicSlug, 'utf8').digest(),
    };
  }

  public async createSession(input: {
    publicSlug: string;
    sessionRequestId: string;
    visitorNonce: string;
    now: Date;
  }): Promise<PublicSessionCreated> {
    if (!Number.isFinite(input.now.getTime())) throw new PublicSessionUnavailableError();
    const { sessionId, visitorCredentialId, sessionHandle, slugDigest } = this.#material(
      input.publicSlug,
      input.sessionRequestId,
      input.visitorNonce,
    );

    const readExisting = async (
      connection: Connection,
      lock: boolean,
    ): Promise<ExistingRow | null> => {
      const [rows] = await connection.execute<ExistingRow[]>(
        `SELECT cs.release_id, cs.created_at, cs.expires_at, cs.status
           FROM conversation_session cs
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
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
        await assertNotWithdrawn(connection, sessionId, visitorCredentialId);
        const existing = await readExisting(connection, true);
        if (existing) return responseFrom(existing);
        const [targets] = await connection.execute<TargetRow[]>(
          `SELECT a.id AS assistant_id, a.merchant_id, r.id AS release_id
             FROM assistant a
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
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

  public async resumeSession(input: {
    publicSlug: string;
    sessionRequestId: string;
    visitorNonce: string;
    now: Date;
  }): Promise<PublicSessionCreated | null> {
    if (!Number.isFinite(input.now.getTime())) return null;
    let material: SessionMaterial;
    try {
      material = this.#material(input.publicSlug, input.sessionRequestId, input.visitorNonce);
    } catch {
      return null;
    }
    const connection = await this.#database.openConnection();
    try {
      await assertNotWithdrawn(connection, material.sessionId, material.visitorCredentialId);
      const [rows] = await connection.execute<ExistingRow[]>(
        `SELECT cs.release_id, cs.created_at, cs.expires_at, cs.status
           FROM conversation_session cs
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
           JOIN merchant m ON m.id = cs.merchant_id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND a.public_slug_digest = ? AND a.public_slug = ?
            AND a.status = 'active' AND m.status = 'active' LIMIT 1`,
        [material.sessionId, material.visitorCredentialId, material.slugDigest, input.publicSlug],
      );
      const row = rows[0];
      if (!row || row.status !== 'active' || row.expires_at.getTime() <= input.now.getTime())
        return null;
      return {
        sessionHandle: material.sessionHandle,
        releaseRef: binaryId(row.release_id),
        state: 'active',
        createdAt: row.created_at.toISOString(),
      };
    } finally {
      await connection.end();
    }
  }

  public async readHistory(
    sessionHandle: string,
    visitorNonce: string,
    now: Date,
  ): Promise<PublicSessionHistory | null> {
    const handle = this.#authorizedHandle(sessionHandle, visitorNonce);
    if (!handle || !Number.isFinite(now.getTime())) return null;
    const connection = await this.#database.openConnection();
    try {
      await assertNotWithdrawn(connection, handle.sessionId, handle.visitorCredentialId);
      const [sessions] = await connection.execute<HistorySessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id, cs.release_id, cs.created_at,
                cs.active_turn_id, a.public_slug,
                m.name AS merchant_name, r.config_snapshot
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
           JOIN assistant_release r
             ON r.merchant_id = cs.merchant_id AND r.assistant_id = cs.assistant_id
            AND r.id = cs.release_id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND cs.status = 'active' AND cs.expires_at > ?
            AND m.status = 'active' AND a.status = 'active' LIMIT 1`,
        [handle.sessionId, handle.visitorCredentialId, now],
      );
      const session = sessions[0];
      if (!session) return null;
      const config = parseConfig(session.config_snapshot);
      const humanContact = normalizeHumanContact(config['humanContact']);
      if (humanContact === null) throw new PublicSessionUnavailableError();
      const releaseRef = binaryId(session.release_id);
      const snapshot = {
        publicAssistantId: publicText(session.public_slug, 128),
        merchantDisplayName: publicText(session.merchant_name, 200),
        assistantDisplayName: publicText(config['displayName'], 200),
        aiDisclosure: true as const,
        businessScope: publicParagraph(config['businessScope'], 2_000),
        welcomeMessage: publicParagraph(config['welcomeMessage'], 2_000),
        humanContact,
        availability: 'online' as const,
        releaseRef,
      };
      const [rows] = await connection.execute<HistoryMessageRow[]>(
        `SELECT id, turn_id, seq_no, role, state, client_request_id, content, created_at
           FROM message
          WHERE merchant_id = ? AND assistant_id = ? AND session_id = ?
          ORDER BY seq_no DESC LIMIT 201`,
        [session.merchant_id, session.assistant_id, handle.sessionId],
      );
      const hasEarlierMessages = rows.length > 200;
      const selected = rows.slice(0, 200).reverse();
      const messages: PublicTurnMessage[] = selected.map((row) => {
        if (row.role !== 'visitor' && row.role !== 'assistant') {
          throw new PublicSessionUnavailableError();
        }
        return {
          messageId: binaryId(row.id),
          sequence: row.seq_no,
          role: row.role,
          content: row.content,
          createdAt: row.created_at.toISOString(),
          ...(row.role === 'visitor' && row.client_request_id
            ? { clientMessageId: row.client_request_id }
            : {}),
        };
      });
      let activeTurn: PublicSessionHistory['activeTurn'] = null;
      if (session.active_turn_id) {
        const active = rows.find(
          (row) =>
            row.turn_id.equals(session.active_turn_id!) &&
            row.role === 'visitor' &&
            (row.state === 'accepted' || row.state === 'processing'),
        );
        if (!active?.client_request_id) throw new PublicSessionUnavailableError();
        activeTurn = {
          turnId: turnRef(session.active_turn_id),
          clientMessageId: active.client_request_id,
          content: active.content,
        };
      }
      await assertNotWithdrawn(connection, handle.sessionId, handle.visitorCredentialId);
      return {
        sessionHandle,
        releaseRef,
        createdAt: session.created_at.toISOString(),
        snapshot,
        messages,
        activeTurn,
        hasEarlierMessages,
      };
    } finally {
      await connection.end();
    }
  }

  public async resolveSession(
    sessionHandle: string,
    visitorNonce: string,
    now: Date,
  ): Promise<PublicSessionContext | null> {
    const handle = this.#authorizedHandle(sessionHandle, visitorNonce);
    if (!handle || !Number.isFinite(now.getTime())) return null;
    const connection = await this.#database.openConnection();
    try {
      await assertNotWithdrawn(connection, handle.sessionId, handle.visitorCredentialId);
      const [rows] = await connection.execute<SessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id, cs.release_id, cs.expires_at,
                r.config_snapshot
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
           JOIN assistant_release r
             ON r.merchant_id = cs.merchant_id AND r.assistant_id = cs.assistant_id
            AND r.id = cs.release_id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND cs.status = 'active' AND cs.expires_at > ?
            AND m.status = 'active' AND a.status = 'active'
          LIMIT 1`,
        [handle.sessionId, handle.visitorCredentialId, now],
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

  public async endSession(input: {
    sessionHandle: string;
    visitorNonce: string;
    now: Date;
  }): Promise<PublicSessionEnded> {
    const handle = this.#authorizedHandle(input.sessionHandle, input.visitorNonce);
    if (!handle || !Number.isFinite(input.now.getTime())) {
      throw new PublicSessionUnavailableError();
    }
    return this.#withTransaction(async (connection) => {
      await assertNotWithdrawn(connection, handle.sessionId, handle.visitorCredentialId);
      const [rows] = await connection.execute<EndSessionRow[]>(
        `SELECT status, active_turn_id
           FROM conversation_session
          WHERE id = ? AND visitor_credential_id = ?
          LIMIT 1 FOR UPDATE`,
        [handle.sessionId, handle.visitorCredentialId],
      );
      const session = rows[0];
      if (!session || (session.status !== 'active' && session.status !== 'ended')) {
        throw new PublicSessionUnavailableError();
      }
      if (session.status === 'ended') {
        return { sessionHandle: input.sessionHandle, state: 'ended' };
      }
      if (session.active_turn_id) throw new PublicTurnConflictError('TURN_IN_PROGRESS');
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE conversation_session
            SET status = 'ended', ended_at = ?, ended_reason = 'visitor_restart',
                last_activity_at = ?, expires_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND visitor_credential_id = ? AND status = 'active'
            AND active_turn_id IS NULL`,
        [input.now, input.now, input.now, input.now, handle.sessionId, handle.visitorCredentialId],
      );
      if (updated.affectedRows !== 1) throw new PublicSessionUnavailableError();
      return { sessionHandle: input.sessionHandle, state: 'ended' };
    });
  }

  public async acceptTurn(input: {
    sessionHandle: string;
    visitorNonce: string;
    clientMessageId: string;
    content: string;
    now: Date;
  }): Promise<PublicTurnAccepted> {
    const handle = this.#authorizedHandle(input.sessionHandle, input.visitorNonce);
    if (
      !handle ||
      !/^message_[0-9a-f]{32}$/u.test(input.clientMessageId) ||
      input.content.trim().length < 1 ||
      input.content.length > 2_000 ||
      !Number.isFinite(input.now.getTime())
    )
      throw new PublicSessionUnavailableError();
    return this.#withTransaction(async (connection) => {
      await assertNotWithdrawn(connection, handle.sessionId, handle.visitorCredentialId);
      const [sessions] = await connection.execute<ActiveSessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id, cs.release_id,
                cs.active_turn_id, cs.next_sequence
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND cs.status = 'active' AND cs.expires_at > ?
            AND m.status = 'active' AND a.status = 'active'
          LIMIT 1 FOR UPDATE`,
        [handle.sessionId, handle.visitorCredentialId, input.now],
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
        if (existing[0].content !== input.content)
          throw new PublicTurnConflictError('IDEMPOTENCY_KEY_REUSED');
        return { turnId: turnRef(existing[0].turn_id), traceId: traceRef(existing[0].turn_id) };
      }
      if (session.active_turn_id !== null) throw new PublicTurnConflictError('TURN_IN_PROGRESS');
      if (
        !Number.isSafeInteger(session.next_sequence) ||
        session.next_sequence < 1 ||
        session.next_sequence >= 4_294_967_295
      ) {
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
        [
          messageId,
          session.merchant_id,
          session.assistant_id,
          handle.sessionId,
          turnId,
          session.next_sequence,
          input.clientMessageId,
          input.content,
          input.now,
        ],
      );
      await connection.execute(
        `UPDATE conversation_session
            SET active_turn_id = ?, next_sequence = ?, last_activity_at = ?,
                expires_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND merchant_id = ? AND assistant_id = ?`,
        [
          turnId,
          session.next_sequence + 1,
          input.now,
          expiresAt,
          input.now,
          handle.sessionId,
          session.merchant_id,
          session.assistant_id,
        ],
      );
      await connection.execute(
        `INSERT INTO job
           (id, merchant_id, type, dedup_key, payload, state, priority,
            attempt, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, 'conversation.turn', ?, ?, 'pending', 0, 0, 5, ?, ?, ?)`,
        [
          jobId,
          session.merchant_id,
          createHash('sha256').update(handle.sessionId).update(turnId).digest(),
          JSON.stringify({
            schemaVersion: 1,
            handlerVersion: 'conversation-v1',
            merchantId: binaryId(session.merchant_id),
            assistantId: binaryId(session.assistant_id),
            sessionId: handle.sessionId.toString('hex'),
            releaseId: binaryId(session.release_id),
            turnId: turnRef(turnId),
          }),
          input.now,
          input.now,
          input.now,
        ],
      );
      return { turnId: turnRef(turnId), traceId: traceRef(turnId) };
    });
  }

  public async readTurn(
    sessionHandle: string,
    visitorNonce: string,
    turnId: string,
    now: Date,
  ): Promise<PublicTurnResult | null> {
    const handle = this.#authorizedHandle(sessionHandle, visitorNonce);
    const turnBuffer = turnIdBuffer(turnId);
    if (!handle || !turnBuffer || !Number.isFinite(now.getTime())) return null;
    const connection = await this.#database.openConnection();
    try {
      await assertNotWithdrawn(connection, handle.sessionId, handle.visitorCredentialId);
      const [sessions] = await connection.execute<ActiveSessionRow[]>(
        `SELECT cs.merchant_id, cs.assistant_id
           FROM conversation_session cs
           JOIN merchant m ON m.id = cs.merchant_id
           JOIN assistant a ON a.merchant_id = cs.merchant_id AND a.id = cs.assistant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
          WHERE cs.id = ? AND cs.visitor_credential_id = ?
            AND cs.status = 'active' AND cs.expires_at > ?
            AND m.status = 'active' AND a.status = 'active' LIMIT 1`,
        [handle.sessionId, handle.visitorCredentialId, now],
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
      if (
        first.state === 'completed' &&
        (rows[1]?.role !== 'assistant' || rows[1].state !== 'completed')
      ) {
        throw new PublicSessionUnavailableError();
      }
      const messages: PublicTurnMessage[] = rows.map((row) => {
        if (row.role !== 'visitor' && row.role !== 'assistant')
          throw new PublicSessionUnavailableError();
        return {
          messageId: binaryId(row.id),
          sequence: row.seq_no,
          role: row.role,
          content: row.content,
          createdAt: row.created_at.toISOString(),
          ...(row.role === 'visitor' && row.client_request_id
            ? { clientMessageId: row.client_request_id }
            : {}),
        };
      });
      await assertNotWithdrawn(connection, handle.sessionId, handle.visitorCredentialId);
      return {
        sessionHandle,
        turnId,
        traceId: traceRef(turnBuffer),
        state: first.state as PublicTurnResult['state'],
        messages,
        ...(first.state === 'failed'
          ? { error: { code: first.error_code ?? 'TURN_FAILED', retryable: false } }
          : {}),
      };
    } finally {
      await connection.end();
    }
  }

  async #withTransaction<TResult>(
    operation: (connection: Connection) => Promise<TResult>,
  ): Promise<TResult> {
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
