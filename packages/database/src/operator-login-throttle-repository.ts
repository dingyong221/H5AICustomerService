import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';

type AttemptRow = RowDataPacket & { attempts: number; expired: number };

const MAX_ATTEMPTS = 5;

export class MySqlOperatorLoginThrottleRepository {
  public constructor(private readonly database: DatabaseConnectionConfig) {}

  public async consumeAttempt(sourceDigest: Buffer): Promise<boolean> {
    if (sourceDigest.byteLength !== 32) throw new Error('Operator login source digest is invalid');
    const connection = await this.database.openConnection();
    try {
      await connection.execute(
        `INSERT INTO platform_operator_login_throttle
           (source_digest, attempts, window_started_at, updated_at)
         VALUES (?, 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE source_digest = source_digest`,
        [sourceDigest],
      );
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute<AttemptRow[]>(
          `SELECT attempts,
                  window_started_at <= UTC_TIMESTAMP(6) - INTERVAL 15 MINUTE AS expired
             FROM platform_operator_login_throttle
            WHERE source_digest = ? FOR UPDATE`,
          [sourceDigest],
        );
        const row = rows[0];
        if (!row || !Number.isSafeInteger(row.attempts) || row.attempts < 0) {
          throw new Error('Operator login throttle row is invalid');
        }
        const expired = row.expired === 1;
        const attempts = expired ? 1 : Math.min(row.attempts + 1, MAX_ATTEMPTS + 1);
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE platform_operator_login_throttle
              SET attempts = ?,
                  window_started_at = CASE WHEN ? THEN UTC_TIMESTAMP(6) ELSE window_started_at END,
                  updated_at = UTC_TIMESTAMP(6)
            WHERE source_digest = ?`,
          [attempts, expired, sourceDigest],
        );
        if (updated.affectedRows !== 1) throw new Error('Operator login throttle update failed');
        await connection.commit();
        await connection
          .execute(
            `DELETE FROM platform_operator_login_throttle
              WHERE updated_at < UTC_TIMESTAMP(6) - INTERVAL 1 DAY
              ORDER BY updated_at LIMIT 50`,
          )
          .catch(() => undefined);
        return attempts <= MAX_ATTEMPTS;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      await connection.end();
    }
  }

  public async clear(sourceDigest: Buffer): Promise<void> {
    if (sourceDigest.byteLength !== 32) throw new Error('Operator login source digest is invalid');
    const connection = await this.database.openConnection();
    try {
      await connection.execute(
        `DELETE FROM platform_operator_login_throttle WHERE source_digest = ?`,
        [sourceDigest],
      );
    } finally {
      await connection.end();
    }
  }
}
