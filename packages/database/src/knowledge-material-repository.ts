import { createHash, randomBytes } from 'node:crypto';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';
export type KnowledgeMaterial = Readonly<{
  id: string;
  name: string;
  size: number;
  sha256: string;
  text: string;
  createdAt: string;
}>;
type MaterialInput = {
  merchantId: string;
  assistantId: string;
  userId: string;
  name: string;
  size: number;
  sha256: string;
  text: string;
};
export class KnowledgeMaterialAccessError extends Error {
  constructor() {
    super('Material access denied');
  }
}
const id = (value: string) => {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new Error('Invalid material scope');
  return Buffer.from(value, 'hex');
};
type MaterialRow = RowDataPacket & {
  id: Buffer;
  title: string;
  source_metadata: unknown;
  created_at: Date;
};
export class MySqlKnowledgeMaterialRepository {
  constructor(private readonly config: DatabaseConnectionConfig) {}
  async assertEditable(merchantId: string, assistantId: string, userId: string): Promise<void> {
    const connection = await this.config.openConnection();
    try {
      await this.#authorize(connection, merchantId, assistantId, userId);
    } finally {
      await connection.end();
    }
  }
  async #authorize(
    connection: Connection,
    merchantId: string,
    assistantId: string,
    userId: string,
    lock = false,
  ) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT a.id FROM assistant a
      JOIN merchant m ON m.id=a.merchant_id JOIN merchant_membership mm ON mm.merchant_id=m.id
      JOIN merchant_user mu ON mu.id=mm.merchant_user_id AND mu.status='active'
      WHERE a.merchant_id=? AND a.id=? AND mm.merchant_user_id=? AND mm.status='active'
      AND mm.role IN ('owner','admin','editor') AND m.status='active' AND a.status <> 'paused' ${lock ? 'FOR UPDATE' : ''}`,
      [id(merchantId), id(assistantId), id(userId)],
    );
    if (!rows.length) throw new KnowledgeMaterialAccessError();
  }
  async list(
    merchantId: string,
    assistantId: string,
    userId: string,
  ): Promise<readonly KnowledgeMaterial[]> {
    const connection = await this.config.openConnection();
    try {
      await this.#authorize(connection, merchantId, assistantId, userId);
      const [rows] = await connection.execute<MaterialRow[]>(
        `SELECT ks.id,ks.title,kr.source_metadata,ks.created_at
        FROM knowledge_source ks JOIN knowledge_revision kr ON kr.merchant_id=ks.merchant_id AND kr.assistant_id=ks.assistant_id
        AND kr.source_id=ks.id AND kr.revision_no=ks.current_revision_no
        WHERE ks.merchant_id=? AND ks.assistant_id=? AND ks.type='uploaded_file' AND ks.status='active'
        ORDER BY ks.created_at DESC,ks.id DESC LIMIT 50`,
        [id(merchantId), id(assistantId)],
      );
      return rows.map((row) => {
        const meta = (
          typeof row.source_metadata === 'string'
            ? JSON.parse(row.source_metadata)
            : row.source_metadata
        ) as { text: string; size: number; sha256: string };
        if (
          !meta ||
          typeof meta.text !== 'string' ||
          !meta.text.trim() ||
          meta.text.length > 24000 ||
          typeof meta.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(meta.sha256) ||
          !Number.isSafeInteger(meta.size) ||
          meta.size < 1 ||
          meta.size > 10 * 1024 * 1024
        )
          throw new Error('Invalid stored material');
        return {
          id: row.id.toString('hex'),
          name: row.title,
          text: meta.text,
          size: meta.size,
          sha256: meta.sha256,
          createdAt: row.created_at.toISOString(),
        };
      });
    } finally {
      await connection.end();
    }
  }
  /** Archive only the uploaded source. Existing draft/release snapshots remain immutable. */
  async archive(input: {
    merchantId: string;
    assistantId: string;
    userId: string;
    sourceId: string;
  }): Promise<void> {
    const merchant = id(input.merchantId),
      assistant = id(input.assistantId),
      source = id(input.sourceId);
    id(input.userId);
    const connection = await this.config.openConnection();
    try {
      await connection.beginTransaction();
      await this.#authorize(connection, input.merchantId, input.assistantId, input.userId, true);
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ks.id,ks.status FROM knowledge_source ks
        WHERE ks.merchant_id=? AND ks.assistant_id=? AND ks.id=? AND ks.type='uploaded_file' FOR UPDATE`,
        [merchant, assistant, source],
      );
      // Missing, foreign-tenant and non-uploaded sources have the same response.
      if (!rows.length || !['active', 'archived'].includes(String(rows[0]!.status)))
        throw new KnowledgeMaterialAccessError();
      if (rows[0]!.status === 'active') {
        await connection.execute(
          `UPDATE knowledge_source SET status='archived',updated_at=UTC_TIMESTAMP(6)
          WHERE merchant_id=? AND assistant_id=? AND id=? AND type='uploaded_file' AND status='active'`,
          [merchant, assistant, source],
        );
        await connection.execute(
          `INSERT INTO audit_log (id,merchant_id,actor_type,actor_id,action,target_type,target_id,result,request_id,created_at,occurred_at)
          VALUES (?,?,'merchant_user',?,'knowledge.material_archive','knowledge_source',?,'success',?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`,
          [
            randomBytes(16),
            merchant,
            input.userId,
            input.sourceId,
            randomBytes(16).toString('hex'),
          ],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }
  async save(input: MaterialInput): Promise<string> {
    return (await this.saveWithResult(input)).id;
  }
  async saveWithResult(input: MaterialInput): Promise<{ id: string; reused: boolean }> {
    if (
      !input.name.trim() ||
      input.name.length > 200 ||
      !Number.isSafeInteger(input.size) ||
      input.size < 1 ||
      input.size > 10 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/u.test(input.sha256) ||
      !input.text.trim() ||
      input.text.length > 24000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text)
    )
      throw new Error('Invalid material');
    const connection = await this.config.openConnection();
    try {
      await connection.beginTransaction();
      await this.#authorize(connection, input.merchantId, input.assistantId, input.userId, true);
      // The authorization row lock serializes uploads for this assistant. Read
      // current active revisions after that lock, including when already full.
      const contentHash = createHash('sha256').update(input.text).digest();
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ks.id,kr.content_hash FROM knowledge_source ks
        JOIN knowledge_revision kr ON kr.merchant_id=ks.merchant_id AND kr.assistant_id=ks.assistant_id
        AND kr.source_id=ks.id AND kr.revision_no=ks.current_revision_no
        WHERE ks.merchant_id=? AND ks.assistant_id=? AND ks.type='uploaded_file' AND ks.status='active'`,
        [id(input.merchantId), id(input.assistantId)],
      );
      const existing = rows.find(
        (row) => Buffer.isBuffer(row.content_hash) && row.content_hash.equals(contentHash),
      );
      if (existing && Buffer.isBuffer(existing.id) && existing.id.length === 16) {
        await connection.commit();
        return { id: existing.id.toString('hex'), reused: true };
      }
      if (rows.length >= 50) throw new Error('最多保存 50 份材料。');
      const source = randomBytes(16),
        revision = randomBytes(16);
      await connection.execute(
        `INSERT INTO knowledge_source (id,merchant_id,assistant_id,type,title,status,current_revision_no,created_at,updated_at)
        VALUES (?,?,?,'uploaded_file',?,'active',1,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`,
        [source, id(input.merchantId), id(input.assistantId), input.name],
      );
      await connection.execute(
        `INSERT INTO knowledge_revision (id,merchant_id,assistant_id,source_id,revision_no,status,content_hash,source_metadata,parser_version,created_at,processed_at)
        VALUES (?,?,?,?,1,'pending_review',?,?,'kreuzberg-4.10.2-v1',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`,
        [
          revision,
          id(input.merchantId),
          id(input.assistantId),
          source,
          contentHash,
          JSON.stringify({ text: input.text, size: input.size, sha256: input.sha256 }),
        ],
      );
      await connection.execute(
        `INSERT INTO audit_log (id,merchant_id,actor_type,actor_id,action,target_type,target_id,result,request_id,created_at,occurred_at)
        VALUES (?,?,'merchant_user',?,'knowledge.material_upload','knowledge_source',?,'success',?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`,
        [
          randomBytes(16),
          id(input.merchantId),
          input.userId,
          source.toString('hex'),
          randomBytes(16).toString('hex'),
        ],
      );
      await connection.commit();
      return { id: source.toString('hex'), reused: false };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }
}
