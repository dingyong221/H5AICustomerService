import { randomBytes, randomUUID } from 'node:crypto';

import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';

export type FollowUpStatus = 'pending' | 'in_progress' | 'resolved';

export type MerchantConversationSummary = Readonly<{
  sessionId: string;
  assistantId: string;
  assistantName: string;
  releaseId: string;
  sessionStatus: string;
  followUpStatus: FollowUpStatus;
  lastActivityAt: Date;
  createdAt: Date;
}>;

export type MerchantConversationMessage = Readonly<{
  id: string;
  sequence: number;
  role: string;
  state: string;
  content: string;
  errorCode: string | null;
  createdAt: Date;
}>;

export type MerchantConversationDetail = Readonly<{
  conversation: MerchantConversationSummary;
  messages: readonly MerchantConversationMessage[];
  olderMessagesOmitted: boolean;
}>;

export class MerchantConversationUnavailableError extends Error {
  public constructor() {
    super('Merchant conversation is unavailable');
    this.name = 'MerchantConversationUnavailableError';
  }
}

type SessionRow = RowDataPacket & {
  id: Buffer;
  assistant_id: Buffer;
  assistant_name: string;
  release_id: Buffer;
  status: string;
  follow_up_status: string;
  last_activity_at: Date;
  last_activity_cursor: string;
  created_at: Date;
};

type MessageRow = RowDataPacket & {
  id: Buffer;
  seq_no: number;
  role: string;
  state: string;
  content: string;
  error_code: string | null;
  created_at: Date;
};

type FollowUpRow = RowDataPacket & { follow_up_status: string };

const idBytes = (value: string): Buffer => {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new MerchantConversationUnavailableError();
  return Buffer.from(value, 'hex');
};

const followUp = (value: string): FollowUpStatus => {
  if (value === 'pending' || value === 'in_progress' || value === 'resolved') return value;
  throw new MerchantConversationUnavailableError();
};

const summary = (row: SessionRow): MerchantConversationSummary => ({
  sessionId: row.id.toString('hex'),
  assistantId: row.assistant_id.toString('hex'),
  assistantName: row.assistant_name,
  releaseId: row.release_id.toString('hex'),
  sessionStatus: row.status,
  followUpStatus: followUp(row.follow_up_status),
  lastActivityAt: row.last_activity_at,
  createdAt: row.created_at,
});

const decodeCursor = (value: string | null): { at: string; id: Buffer } | null => {
  if (value === null) return null;
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw new MerchantConversationUnavailableError();
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    const record = decoded as Record<string, unknown>;
    if (typeof record['at'] !== 'string' || typeof record['id'] !== 'string') throw new Error();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(record['at'])) {
      throw new Error();
    }
    return { at: record['at'], id: idBytes(record['id']) };
  } catch {
    throw new MerchantConversationUnavailableError();
  }
};

const encodeCursor = (row: SessionRow): string =>
  Buffer.from(
    JSON.stringify({ at: row.last_activity_cursor, id: row.id.toString('hex') }),
    'utf8',
  ).toString('base64url');

export class MySqlMerchantConversationRepository {
  public constructor(private readonly database: DatabaseConnectionConfig) {}

  public async list(input: {
    merchantId: string;
    merchantUserId: string;
    cursor?: string | null;
    followUpStatus?: FollowUpStatus | null;
    limit?: number;
  }): Promise<{ items: readonly MerchantConversationSummary[]; nextCursor: string | null }> {
    const merchantId = idBytes(input.merchantId);
    const merchantUserId = idBytes(input.merchantUserId);
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new MerchantConversationUnavailableError();
    }
    const cursor = decodeCursor(input.cursor ?? null);
    const status = input.followUpStatus ? followUp(input.followUpStatus) : null;
    const values: Array<string | number | Buffer> = [merchantUserId, merchantId];
    const filters: string[] = [];
    if (status) {
      filters.push('cs.follow_up_status = ?');
      values.push(status);
    }
    if (cursor) {
      filters.push('(cs.last_activity_at < ? OR (cs.last_activity_at = ? AND cs.id < ?))');
      values.push(cursor.at, cursor.at, cursor.id);
    }
    values.push(limit + 1);
    const connection = await this.database.openConnection();
    try {
      const [rows] = await connection.execute<SessionRow[]>(
        `SELECT cs.id, cs.assistant_id, a.display_name AS assistant_name,
                cs.release_id, cs.status, cs.follow_up_status,
                cs.last_activity_at,
                DATE_FORMAT(cs.last_activity_at, '%Y-%m-%d %H:%i:%s.%f') AS last_activity_cursor,
                cs.created_at
           FROM conversation_session cs
           JOIN assistant a ON a.id = cs.assistant_id AND a.merchant_id = cs.merchant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
           JOIN merchant m ON m.id = cs.merchant_id AND m.status = 'active'
           JOIN merchant_membership mm ON mm.merchant_id = cs.merchant_id
             AND mm.merchant_user_id = ? AND mm.status = 'active'
           JOIN merchant_user u ON u.id = mm.merchant_user_id AND u.status = 'active'
          WHERE cs.merchant_id = ?${filters.length ? ` AND ${filters.join(' AND ')}` : ''}
          ORDER BY cs.last_activity_at DESC, cs.id DESC LIMIT ?`,
        values,
      );
      const visible = rows.slice(0, limit);
      return {
        items: visible.map(summary),
        nextCursor:
          rows.length > limit && visible.length > 0 ? encodeCursor(visible.at(-1)!) : null,
      };
    } finally {
      await connection.end();
    }
  }

  public async detail(input: {
    merchantId: string;
    merchantUserId: string;
    sessionId: string;
  }): Promise<MerchantConversationDetail | null> {
    const merchantId = idBytes(input.merchantId);
    const merchantUserId = idBytes(input.merchantUserId);
    const sessionId = idBytes(input.sessionId);
    const connection = await this.database.openConnection();
    try {
      const [sessions] = await connection.execute<SessionRow[]>(
        `SELECT cs.id, cs.assistant_id, a.display_name AS assistant_name,
                cs.release_id, cs.status, cs.follow_up_status,
                cs.last_activity_at,
                DATE_FORMAT(cs.last_activity_at, '%Y-%m-%d %H:%i:%s.%f') AS last_activity_cursor,
                cs.created_at
           FROM conversation_session cs
           JOIN assistant a ON a.id = cs.assistant_id AND a.merchant_id = cs.merchant_id
           JOIN merchant_assistant current_assistant ON current_assistant.merchant_id = a.merchant_id AND current_assistant.assistant_id = a.id
           JOIN merchant m ON m.id = cs.merchant_id AND m.status = 'active'
           JOIN merchant_membership mm ON mm.merchant_id = cs.merchant_id
             AND mm.merchant_user_id = ? AND mm.status = 'active'
           JOIN merchant_user u ON u.id = mm.merchant_user_id AND u.status = 'active'
          WHERE cs.merchant_id = ? AND cs.id = ? LIMIT 1`,
        [merchantUserId, merchantId, sessionId],
      );
      if (!sessions[0]) return null;
      const [rows] = await connection.execute<MessageRow[]>(
        `SELECT id, seq_no, role, state, content, error_code, created_at
           FROM message
          WHERE merchant_id = ? AND session_id = ?
          ORDER BY seq_no DESC LIMIT 101`,
        [merchantId, sessionId],
      );
      return {
        conversation: summary(sessions[0]),
        messages: rows
          .slice(0, 100)
          .reverse()
          .map((row) => ({
            id: row.id.toString('hex'),
            sequence: row.seq_no,
            role: row.role,
            state: row.state,
            content: row.content,
            errorCode: row.error_code,
            createdAt: row.created_at,
          })),
        olderMessagesOmitted: rows.length > 100,
      };
    } finally {
      await connection.end();
    }
  }

  public async setFollowUpStatus(input: {
    merchantId: string;
    merchantUserId: string;
    sessionId: string;
    status: FollowUpStatus;
  }): Promise<void> {
    const merchantId = idBytes(input.merchantId);
    const merchantUserId = idBytes(input.merchantUserId);
    const sessionId = idBytes(input.sessionId);
    const status = followUp(input.status);
    const connection = await this.database.openConnection();
    try {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute<FollowUpRow[]>(
          `SELECT cs.follow_up_status
             FROM conversation_session cs
             JOIN merchant m ON m.id = cs.merchant_id AND m.status = 'active'
             JOIN merchant_membership mm ON mm.merchant_id = cs.merchant_id
               AND mm.merchant_user_id = ? AND mm.status = 'active'
             JOIN merchant_user u ON u.id = mm.merchant_user_id AND u.status = 'active'
            WHERE cs.merchant_id = ? AND cs.id = ? AND mm.role IN ('owner','admin','editor') LIMIT 1 FOR UPDATE`,
          [merchantUserId, merchantId, sessionId],
        );
        if (!rows[0]) throw new MerchantConversationUnavailableError();
        const previous = followUp(rows[0].follow_up_status);
        if (previous !== status) {
          const [updated] = await connection.execute<ResultSetHeader>(
            `UPDATE conversation_session
                SET follow_up_status = ?, updated_at = UTC_TIMESTAMP(6)
              WHERE id = ? AND merchant_id = ?`,
            [status, sessionId, merchantId],
          );
          if (updated.affectedRows !== 1) throw new MerchantConversationUnavailableError();
          await connection.execute(
            `INSERT INTO audit_log
               (id, merchant_id, actor_type, actor_id, action, target_type, target_id,
                result, request_id, metadata, occurred_at, created_at)
             VALUES (?, ?, 'merchant_user', ?, 'conversation.follow_up_status.update',
                     'conversation_session', ?, 'success', ?, ?,
                     UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
            [
              randomBytes(16),
              merchantId,
              input.merchantUserId,
              input.sessionId,
              randomUUID(),
              JSON.stringify({ previous, current: status }),
            ],
          );
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      await connection.end().catch(() => undefined);
    }
  }
}
