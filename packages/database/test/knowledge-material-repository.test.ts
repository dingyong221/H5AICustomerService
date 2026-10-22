import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from '../src/config.js';
import { createHash } from 'node:crypto';
import {
  KnowledgeMaterialAccessError,
  MySqlKnowledgeMaterialRepository,
} from '../src/knowledge-material-repository.js';

const merchantId = 'aa'.repeat(16),
  assistantId = 'bb'.repeat(16),
  userId = 'cc'.repeat(16);
const input = {
  merchantId,
  assistantId,
  userId,
  name: '商品表.xlsx',
  size: 1024,
  sha256: 'ef'.repeat(32),
  text: '毛巾 29 元/条，运费待确认。',
};
function fixture(
  respond: (sql: string) => unknown[] = (sql) =>
    sql.includes('SELECT a.id') ? [{ id: Buffer.from(assistantId, 'hex') }] : [],
) {
  const execute = vi.fn(async (sql: string, _values?: unknown[]) => [respond(sql), []]);
  const beginTransaction = vi.fn(),
    commit = vi.fn(),
    rollback = vi.fn(),
    end = vi.fn();
  const connection = { execute, beginTransaction, commit, rollback, end } as unknown as Connection;
  const openConnection = vi.fn(async () => connection);
  const summary = { host: 'isolated.invalid', database: 'unit', tlsRequested: false };
  const config = {
    openConnection,
    summary,
    toJSON: () => summary,
  } satisfies DatabaseConnectionConfig;
  return {
    repository: new MySqlKnowledgeMaterialRepository(config),
    execute,
    beginTransaction,
    commit,
    rollback,
    end,
    openConnection,
  };
}
describe('merchant uploaded material isolation and persistence', () => {
  it('checks assistant edit authority without reading any material content', async () => {
    const allowed = fixture();
    await allowed.repository.assertEditable(merchantId, assistantId, userId);
    expect(allowed.execute).toHaveBeenCalledOnce();
    expect(allowed.execute.mock.calls[0]?.[0]).toContain("mm.role IN ('owner','admin','editor')");
    expect(allowed.end).toHaveBeenCalledOnce();
    const denied = fixture(() => []);
    await expect(
      denied.repository.assertEditable(merchantId, assistantId, userId),
    ).rejects.toBeInstanceOf(KnowledgeMaterialAccessError);
    expect(denied.end).toHaveBeenCalledOnce();
  });
  it('authorizes tenant, assistant, active member and edit role before reading material text', async () => {
    const f = fixture(() => []);
    await expect(f.repository.list(merchantId, assistantId, userId)).rejects.toBeInstanceOf(
      KnowledgeMaterialAccessError,
    );
    expect(f.execute).toHaveBeenCalledOnce();
    const [sql, values] = f.execute.mock.calls[0] as unknown as [string, Buffer[]];
    expect(sql).toContain('a.merchant_id=? AND a.id=? AND mm.merchant_user_id=?');
    expect(sql).toContain("mm.status='active'");
    expect(sql).toContain("mu.status='active'");
    expect(sql).toContain("mm.role IN ('owner','admin','editor')");
    expect(sql).toContain("m.status='active'");
    expect(sql).toContain("a.status <> 'paused'");
    expect(values.map((v) => v.toString('hex'))).toEqual([merchantId, assistantId, userId]);
    expect(f.end).toHaveBeenCalledOnce();
  });
  it('joins source revision with all tenant and assistant keys and returns bounded metadata', async () => {
    const sourceId = 'dd'.repeat(16);
    const f = fixture((sql) =>
      sql.includes('SELECT a.id')
        ? [{}]
        : [
            {
              id: Buffer.from(sourceId, 'hex'),
              title: input.name,
              created_at: new Date('2026-10-20T00:00:00Z'),
              source_metadata: JSON.stringify({
                text: input.text,
                size: input.size,
                sha256: input.sha256,
              }),
            },
          ],
    );
    await expect(f.repository.list(merchantId, assistantId, userId)).resolves.toEqual([
      {
        id: sourceId,
        name: input.name,
        text: input.text,
        size: input.size,
        sha256: input.sha256,
        createdAt: '2026-10-20T00:00:00.000Z',
      },
    ]);
    const sql = f.execute.mock.calls[1]?.[0] ?? '';
    expect(sql).toContain('kr.merchant_id=ks.merchant_id AND kr.assistant_id=ks.assistant_id');
    expect(sql).toContain('kr.source_id=ks.id AND kr.revision_no=ks.current_revision_no');
    expect(sql).toContain(
      "ks.merchant_id=? AND ks.assistant_id=? AND ks.type='uploaded_file' AND ks.status='active'",
    );
    expect(sql).toContain('LIMIT 50');
  });
  it.each([
    null,
    { text: 'x', size: 1, sha256: 'broken' },
    { text: 'x'.repeat(24001), size: 1, sha256: input.sha256 },
    { text: 'x', size: -1, sha256: input.sha256 },
  ])(
    'rejects invalid stored metadata without exposing untrusted values',
    async (source_metadata) => {
      const f = fixture((sql) =>
        sql.includes('SELECT a.id')
          ? [{}]
          : [{ id: Buffer.alloc(16), title: 'a', created_at: new Date(), source_metadata }],
      );
      await expect(f.repository.list(merchantId, assistantId, userId)).rejects.toThrow(
        'Invalid stored material',
      );
      expect(f.end).toHaveBeenCalledOnce();
    },
  );
  it('saves source, pending-review revision and audit in one transaction, without publishing', async () => {
    const f = fixture();
    const source = await f.repository.save(input);
    expect(source).toMatch(/^[0-9a-f]{32}$/u);
    expect(f.beginTransaction).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.rollback).not.toHaveBeenCalled();
    const statements = f.execute.mock.calls.map(([sql]) => sql).join('\n');
    expect(statements).toContain('FOR UPDATE');
    expect(statements).toContain("'pending_review'");
    expect(statements).toContain('knowledge.material_upload');
    expect(statements).not.toMatch(
      /INSERT INTO (assistant_release|knowledge_chunk)|UPDATE assistant/u,
    );
    expect(f.end).toHaveBeenCalledOnce();
  });
  it('reuses exact text within the authorized assistant before applying the 50 source limit, without overwriting its original name', async () => {
    const sourceId = 'dd'.repeat(16);
    const f = fixture((sql) =>
      sql.includes('SELECT a.id')
        ? [{}]
        : Array.from({ length: 50 }, () => ({
            id: Buffer.from(sourceId, 'hex'),
            content_hash: createHash('sha256').update(input.text).digest(),
          })),
    );
    await expect(
      f.repository.saveWithResult({ ...input, name: '重传的新文件名.xlsx' }),
    ).resolves.toEqual({ id: sourceId, reused: true });
    expect(f.commit).toHaveBeenCalledOnce();
    const statements = f.execute.mock.calls.map(([sql]) => sql).join('\n');
    expect(statements).toContain(
      'kr.merchant_id=ks.merchant_id AND kr.assistant_id=ks.assistant_id',
    );
    expect(statements).toContain(
      "ks.merchant_id=? AND ks.assistant_id=? AND ks.type='uploaded_file' AND ks.status='active'",
    );
    expect(statements).not.toMatch(/INSERT|UPDATE knowledge|DELETE/u);
    expect(f.rollback).not.toHaveBeenCalled();
  });
  it('does not merge a different price, and retains the legacy save string API', async () => {
    const f = fixture((sql) =>
      sql.includes('SELECT a.id')
        ? [{}]
        : sql.includes('SELECT ks.id,kr.content_hash')
          ? [
              {
                id: Buffer.from('dd'.repeat(16), 'hex'),
                content_hash: createHash('sha256').update('毛巾 39 元/条').digest(),
              },
            ]
          : [],
    );
    await expect(f.repository.saveWithResult(input)).resolves.toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/u),
      reused: false,
    });
    expect(f.execute.mock.calls.map(([sql]) => sql).join('\n')).toContain(
      'INSERT INTO knowledge_source',
    );
    await expect(fixture().repository.save(input)).resolves.toMatch(/^[0-9a-f]{32}$/u);
  });
  it('rolls back denied or full assistants, preserving existing sources and releases', async () => {
    for (const full of [false, true]) {
      const f = fixture((sql) =>
        sql.includes('SELECT a.id') ? (full ? [{}] : []) : Array.from({ length: 50 }, () => ({})),
      );
      await expect(f.repository.save(input)).rejects.toThrow();
      expect(f.rollback).toHaveBeenCalledOnce();
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.execute.mock.calls.every(([sql]) => !sql.includes('INSERT'))).toBe(true);
      expect(f.end).toHaveBeenCalledOnce();
    }
  });
  it('archives only the exact tenant uploaded source and audits once, without changing draft or published state', async () => {
    const sourceId = 'dd'.repeat(16);
    let status = 'active';
    const f = fixture((sql) => {
      if (sql.includes('SELECT a.id')) return [{}];
      if (sql.includes('SELECT ks.id,ks.status'))
        return [{ id: Buffer.from(sourceId, 'hex'), status }];
      if (sql.startsWith('UPDATE knowledge_source')) status = 'archived';
      return [];
    });
    const scope = { merchantId, assistantId, userId, sourceId };
    await f.repository.archive(scope);
    await f.repository.archive(scope);
    expect(status).toBe('archived');
    expect(f.commit).toHaveBeenCalledTimes(2);
    expect(f.rollback).not.toHaveBeenCalled();
    const statements = f.execute.mock.calls.map(([sql]) => sql);
    const reads = f.execute.mock.calls.filter(([sql]) => sql.includes('SELECT ks.id,ks.status'));
    expect(reads).toHaveLength(2);
    expect(reads[0]?.[0]).toContain(
      "ks.merchant_id=? AND ks.assistant_id=? AND ks.id=? AND ks.type='uploaded_file' FOR UPDATE",
    );
    expect((reads[0]?.[1] as Buffer[]).map((value) => value.toString('hex'))).toEqual([
      merchantId,
      assistantId,
      sourceId,
    ]);
    expect(statements.filter((sql) => sql.startsWith('UPDATE knowledge_source'))).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes('knowledge.material_archive'))).toHaveLength(1);
    expect(statements.join('\n')).not.toMatch(
      /DELETE FROM|UPDATE assistant|UPDATE knowledge_revision|INSERT INTO assistant_release/u,
    );
  });
  it.each(['denied-member', 'missing-source', 'foreign-scope', 'non-uploaded', 'inactive-source'])(
    'rejects %s within the transaction without any mutation',
    async (reason) => {
      const f = fixture((sql) =>
        sql.includes('SELECT a.id')
          ? reason === 'denied-member'
            ? []
            : [{}]
          : reason === 'inactive-source'
            ? [{ status: 'inactive' }]
            : [],
      );
      await expect(
        f.repository.archive({ merchantId, assistantId, userId, sourceId: 'dd'.repeat(16) }),
      ).rejects.toBeInstanceOf(KnowledgeMaterialAccessError);
      expect(f.beginTransaction).toHaveBeenCalledOnce();
      expect(f.rollback).toHaveBeenCalledOnce();
      expect(f.commit).not.toHaveBeenCalled();
      expect(
        f.execute.mock.calls.every(([sql]) => !/UPDATE knowledge|INSERT|DELETE/u.test(sql)),
      ).toBe(true);
      expect(f.end).toHaveBeenCalledOnce();
    },
  );
  it('rolls back the archive if its audit cannot be written', async () => {
    const f = fixture((sql) => {
      if (sql.includes('SELECT a.id')) return [{}];
      if (sql.includes('SELECT ks.id,ks.status')) return [{ status: 'active' }];
      if (sql.includes('INSERT INTO audit_log')) throw new Error('audit unavailable');
      return [];
    });
    await expect(
      f.repository.archive({ merchantId, assistantId, userId, sourceId: 'dd'.repeat(16) }),
    ).rejects.toThrow('audit unavailable');
    expect(f.rollback).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.end).toHaveBeenCalledOnce();
  });
  it.each(['merchantId', 'assistantId', 'userId', 'sourceId'] as const)(
    'rejects malformed archive %s before opening a connection',
    async (key) => {
      const f = fixture();
      await expect(
        f.repository.archive({
          merchantId,
          assistantId,
          userId,
          sourceId: 'dd'.repeat(16),
          [key]: '../invalid',
        }),
      ).rejects.toThrow('Invalid material scope');
      expect(f.openConnection).not.toHaveBeenCalled();
    },
  );
  it.each([
    { text: '' },
    { text: 'x'.repeat(24001) },
    { text: 'bad\u0000value' },
    { size: 0 },
    { size: 10 * 1024 * 1024 + 1 },
    { sha256: 'x' },
    { name: 'x'.repeat(201) },
  ])('rejects invalid upload metadata before database work', async (patch) => {
    const f = fixture();
    await expect(f.repository.save({ ...input, ...patch })).rejects.toThrow('Invalid material');
    expect(f.openConnection).not.toHaveBeenCalled();
  });
});
