import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  MySqlPlatformAnalyticsRepository,
  platformReportDays,
  platformReportRange,
} from '../src/platform-analytics-repository.js';

const now = new Date('2026-10-17T18:00:00.000Z');
const range = { from: '2026-10-16', to: '2026-10-17' };
const id = '11'.repeat(16);
const generatedAt = '2026-10-17T18:00:00.000000Z';
const zero = {
  merchants: 0,
  pending_owner: 0,
  enabled_merchants: 0,
  paused_merchants: 0,
  assistants: 0,
  published_assistants: 0,
  sessions: 0,
  questions: 0,
  completed: 0,
  failed: 0,
  pending: 0,
  mean_response_ms: null,
  using_merchants: 0,
  improvements: 0,
  published_improvements: 0,
  evaluations: 0,
  evaluation_completed: 0,
  evaluation_failed: 0,
  evaluation_pending: 0,
  verdict_pass: 0,
  verdict_fail: 0,
  unreviewed: 0,
};
const merchantRow = {
  ...zero,
  id: Buffer.from(id, 'hex'),
  name: '合成商家',
  status: 'active',
  created_at: generatedAt,
  last_consultation_at: null,
};
function databaseWith(
  respond: (sql: string, values: readonly unknown[]) => unknown[] = (sql) =>
    sql.includes('GROUP BY') ? [] : [zero],
) {
  const query = vi.fn(async () => [[], []]);
  const execute = vi.fn(async (sql: string, values: readonly unknown[]) => [
    sql.includes('AS generated_at') ? [{ generated_at: generatedAt }] : respond(sql, values),
    [],
  ]);
  const beginTransaction = vi.fn(async () => undefined),
    commit = vi.fn(async () => undefined),
    rollback = vi.fn(async () => undefined),
    end = vi.fn(async () => undefined);
  const connection = {
    query,
    execute,
    beginTransaction,
    commit,
    rollback,
    end,
  } as unknown as Connection;
  const openConnection = vi.fn(async () => connection);
  const summary = { host: 'test', database: 'test', tlsRequested: false };
  const database = {
    openConnection,
    summary,
    toJSON: () => summary,
  } satisfies DatabaseConnectionConfig;
  return {
    repository: new MySqlPlatformAnalyticsRepository(database),
    query,
    execute,
    beginTransaction,
    commit,
    rollback,
    end,
    openConnection,
  };
}

describe('Beijing analytics date ranges', () => {
  it('switches the reporting day at Beijing midnight, not the host midnight', () => {
    expect(platformReportRange({ days: 1 }, new Date('2026-10-17T15:59:59Z'))).toEqual({
      from: '2026-10-17',
      to: '2026-10-17',
    });
    expect(platformReportRange({ days: 7 }, now)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
  });
  it('includes leap days and the end day', () => {
    expect(platformReportDays({ from: '2024-02-28', to: '2024-03-01' })).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
  });
  it.each([
    { from: '2026-02-29', to: '2026-03-01' },
    { from: '2026-10-17' },
    { from: '2026-10-18', to: '2026-10-17' },
    { from: '2026-10-19', to: '2026-10-19' },
    { from: '2026-01-01', to: '2026-10-01' },
    { days: 0 },
    { days: 94 },
    { days: 1.5 },
  ])('rejects invalid, partial, future or unbounded intervals %j', (input) => {
    expect(() => platformReportRange(input, now)).toThrow();
  });
});

describe('platform read-only analytics', () => {
  it('uses a repeatable-read read-only transaction and preserves zero-use days', async () => {
    const db = databaseWith();
    const result = await db.repository.analytics(range);
    expect(db.query.mock.calls).toEqual([
      ['SET SESSION MAX_EXECUTION_TIME = 8000'],
      ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'],
    ]);
    expect(db.beginTransaction).toHaveBeenCalledOnce();
    expect(db.commit).toHaveBeenCalledOnce();
    expect(db.rollback).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledOnce();
    expect(result.daily).toEqual(
      range.from === range.to
        ? []
        : [
            {
              day: '2026-10-16',
              newMerchants: 0,
              sessions: 0,
              questions: 0,
              completed: 0,
              failed: 0,
              pending: 0,
              meanResponseMs: null,
            },
            {
              day: '2026-10-17',
              newMerchants: 0,
              sessions: 0,
              questions: 0,
              completed: 0,
              failed: 0,
              pending: 0,
              meanResponseMs: null,
            },
          ],
    );
    expect(result.inventory.merchants).toBe(0);
    expect(result.usage.meanResponseMs).toBeNull();
    expect(db.execute.mock.calls.every(([sql]) => sql.trim().startsWith('SELECT'))).toBe(true);
    expect(
      db.execute.mock.calls.every(
        ([sql]) => !/\b(content|payload|password_hash|phone|visitor_credential_id)\b/iu.test(sql),
      ),
    ).toBe(true);
  });
  it('binds UTC strings, exact tenant scopes and independent aggregation queries', async () => {
    const db = databaseWith((sql) => {
      if (sql.includes('GROUP BY day') && sql.includes('FROM message'))
        return [
          {
            day: '2026-10-17',
            ...zero,
            questions: '4',
            completed: '2',
            failed: '1',
            pending: '1',
            mean_response_ms: '1250.5000',
          },
        ];
      if (sql.includes('GROUP BY day') && sql.includes('FROM conversation_session'))
        return [{ day: '2026-10-16', sessions: 2 }];
      if (sql.includes('GROUP BY')) return [];
      return [
        {
          ...zero,
          merchants: 80,
          questions: '4',
          completed: '2',
          failed: '1',
          pending: '1',
          using_merchants: 1,
          mean_response_ms: '1250.5000',
          sessions: 2,
        },
      ];
    });
    const result = await db.repository.analytics(range, id);
    expect(result.inventory.merchants).toBe(80);
    expect(result.usage.meanResponseMs).toBe(1251);
    expect(result.daily[0]?.sessions).toBe(2);
    expect(result.daily[0]?.questions).toBe(0);
    expect(result.daily[1]?.questions).toBe(4);
    expect(result.daily[1]?.sessions).toBe(0);
    for (const [sql, values] of db.execute.mock.calls.filter(([sql]) =>
      sql.includes('created_at >= ?'),
    )) {
      expect(values.slice(0, 3)).toEqual([
        '2026-10-15 16:00:00.000',
        '2026-10-17 16:00:00.000',
        Buffer.from(id, 'hex'),
      ]);
      expect(values.some((value) => value instanceof Date)).toBe(false);
    }
    expect(
      db.execute.mock.calls.find(([sql]) => sql.includes('FROM assistant_improvement'))?.[0],
    ).toContain('published_task_version = version');
  });
  it('keeps inventory totals separate from the paginated list and binds literal search', async () => {
    const db = databaseWith((sql) =>
      sql.includes('COUNT(*) AS total') ? [{ total: '73' }] : [merchantRow],
    );
    const result = await db.repository.merchants(
      range,
      { search: 'a%_!', status: 'active', activity: 'unused', sort: 'questions' },
      2,
      20,
    );
    expect(result.total).toBe(73);
    expect(result.items).toHaveLength(1);
    expect(result.page).toBe(2);
    const [, values] = db.execute.mock.calls.at(-1)!;
    expect(values).toContain('%a!%!_!!%');
    expect(values.slice(-2)).toEqual([20, 20]);
    const sql = db.execute.mock.calls.at(-1)![0];
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("activity.role = 'visitor'");
    expect(sql).toContain('ORDER BY questions DESC, m.id DESC');
    expect(sql).toContain('LEFT JOIN (SELECT merchant_id');
  });
  it('matches full merchant IDs exactly instead of interpolating them', async () => {
    const db = databaseWith((sql) =>
      sql.includes('COUNT(*) AS total') ? [{ total: 1 }] : [merchantRow],
    );
    await db.repository.merchants(range, { search: id.toUpperCase() });
    expect(db.execute.mock.calls[1]?.[0]).toContain('m.id = ?');
    expect(db.execute.mock.calls[1]?.[1]).toContainEqual(Buffer.from(id, 'hex'));
  });
  it('scopes assistant aggregates by both merchant and assistant', async () => {
    const db = databaseWith((sql) => (sql.includes('COUNT(*) AS total') ? [{ total: 0 }] : []));
    await db.repository.assistants(range, id);
    const [sql, values] = db.execute.mock.calls.at(-1)!;
    expect(sql).toContain('s.merchant_id = a.merchant_id AND s.assistant_id = a.id');
    expect(sql).toContain('q.merchant_id = a.merchant_id AND q.assistant_id = a.id');
    expect(sql).toContain('WHERE a.merchant_id = ?');
    expect(values).toContainEqual(Buffer.from(id, 'hex'));
  });
  it.each([
    { sort: 'questions; DROP TABLE merchant' },
    { status: 'invented' },
    { activity: 'true' },
    { merchantId: 'bad' },
    { search: 'a' },
  ])('rejects invalid filters before opening a connection %j', async (filters) => {
    const db = databaseWith();
    await expect(db.repository.merchants(range, filters as never)).rejects.toThrow();
    expect(db.openConnection).not.toHaveBeenCalled();
  });
  it.each([
    [0, 20],
    [1, 0],
    [1, 5002],
    [1.5, 20],
    [100001, 20],
  ])('bounds page %i / size %i before connection', async (page, size) => {
    const db = databaseWith();
    await expect(db.repository.merchants(range, {}, page, size)).rejects.toThrow();
    expect(db.openConnection).not.toHaveBeenCalled();
  });
  it('fails closed on database errors, rolls back and closes the connection', async () => {
    const db = databaseWith(() => {
      throw new Error('query unavailable');
    });
    await expect(db.repository.analytics(range)).rejects.toThrow('query unavailable');
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledOnce();
  });
  it.each([undefined, null, '', '-1', '9007199254740992', Number.NaN])(
    'never turns a missing or unsafe metric %s into zero',
    async (value) => {
      const db = databaseWith((sql) =>
        sql.includes('GROUP BY') ? [] : [{ ...zero, merchants: value }],
      );
      await expect(db.repository.analytics(range)).rejects.toThrow('Invalid analytics count');
      expect(db.rollback).toHaveBeenCalledOnce();
    },
  );
});
