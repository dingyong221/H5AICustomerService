import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loadDatabaseConfig,
  MySqlPlatformAnalyticsRepository,
  MySqlPlatformProvisioningRepository,
} from '@h5cs/database';
import type { Connection } from 'mysql2/promise';

const url = process.env['H5CS_INTEGRATION_MYSQL_URL'];
if (!url) throw new Error('Dedicated integration database required');
const target = new URL(url);
if (
  target.protocol !== 'mysql:' ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  target.pathname !== '/h5cs_integration_ci' ||
  target.username !== 'h5cs_ci' ||
  target.search ||
  target.hash
)
  throw new Error('Analytics fixtures must never run against merchant databases');
const config = loadDatabaseConfig({ MYSQL_DATABASE_URL: url, NODE_ENV: 'test', APP_ENV: 'test' });
if (!config.configured) throw new Error('Dedicated database unavailable');
const database = config.config;
const range = { from: '2026-10-16', to: '2026-10-17' };
const uuid = () => randomBytes(16);

async function merchant(connection: Connection, name: string) {
  const id = uuid();
  await connection.execute(
    `INSERT INTO merchant (id, name, status, timezone, created_at, updated_at) VALUES (?, ?, 'active', 'Asia/Shanghai', '2026-10-16 00:00:00', '2026-10-16 00:00:00')`,
    [id, name],
  );
  return id;
}
async function assistant(connection: Connection, merchantId: Buffer) {
  const id = uuid(),
    release = uuid(),
    slug = `synthetic-${id.toString('hex')}`;
  await connection.execute(
    `INSERT INTO assistant (id, merchant_id, display_name, public_slug, public_slug_digest, status, created_at, updated_at) VALUES (?, ?, '运营统计合成客服', ?, ?, 'draft_only', '2026-10-16 00:00:00', '2026-10-16 00:00:00')`,
    [id, merchantId, slug, createHash('sha256').update(slug).digest()],
  );
  await connection.execute(
    `INSERT INTO assistant_release (id, merchant_id, assistant_id, release_no, draft_revision, status, config_snapshot, prompt_template_version, retrieval_policy_version, model_policy_version, created_at) VALUES (?, ?, ?, 1, 1, 'published', '{}', 'synthetic', 'synthetic', 'synthetic', '2026-10-16 00:00:00')`,
    [release, merchantId, id],
  );
  await connection.execute(
    `UPDATE assistant SET status = 'active', active_release_id = ? WHERE id = ?`,
    [release, id],
  );
  return { id, merchantId, release };
}
type Assistant = Awaited<ReturnType<typeof assistant>>;
async function session(connection: Connection, a: Assistant, createdAt: string) {
  const id = uuid();
  await connection.execute(
    `INSERT INTO conversation_session (id, merchant_id, assistant_id, release_id, visitor_credential_id, status, last_activity_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, '2027-01-01 00:00:00', ?, ?)`,
    [id, a.merchantId, a.id, a.release, uuid(), createdAt, createdAt, createdAt],
  );
  return id;
}
async function question(
  connection: Connection,
  a: Assistant,
  sessionId: Buffer,
  sequence: number,
  createdAt: string,
  state: string,
  completedAt: string | null,
) {
  const turn = uuid();
  await connection.execute(
    `INSERT INTO message (id, merchant_id, assistant_id, session_id, turn_id, seq_no, role, state, content, error_code, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, 'visitor', ?, 'SYNTHETIC_PRIVATE_QUESTION_NOT_FOR_EXPORT', ?, ?, ?)`,
    [
      uuid(),
      a.merchantId,
      a.id,
      sessionId,
      turn,
      sequence,
      state,
      state === 'failed' ? 'synthetic_failure' : null,
      createdAt,
      completedAt,
    ],
  );
  if (state === 'completed')
    await connection.execute(
      `INSERT INTO message (id, merchant_id, assistant_id, session_id, turn_id, seq_no, role, state, content, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, 'assistant', 'completed', 'SYNTHETIC_ANSWER_NOT_REAL_MODEL', ?, ?)`,
      [uuid(), a.merchantId, a.id, sessionId, turn, sequence + 1, completedAt, completedAt],
    );
}

describe('real MySQL platform reporting', () => {
  it('counts each consumer question once, respects Beijing boundaries, and keeps paused-merchant history', async () => {
    const connection = await database.openConnection();
    let aId: Buffer, bId: Buffer;
    const prefix = `OPS_ANALYTICS_${randomBytes(6).toString('hex')}`;
    try {
      aId = await merchant(connection, `${prefix}_A`);
      bId = await merchant(connection, `${prefix}_B`);
      const a1 = await assistant(connection, aId),
        a2 = await assistant(connection, aId),
        b = await assistant(connection, bId);
      const old = await session(connection, a1, '2026-10-14 12:00:00');
      const fresh = await session(connection, a2, '2026-10-16 00:00:00');
      const other = await session(connection, b, '2026-10-17 00:00:00');
      await question(
        connection,
        a1,
        old,
        1,
        '2026-10-15 15:59:59.999999',
        'completed',
        '2026-10-15 16:00:01',
      );
      await question(
        connection,
        a1,
        old,
        3,
        '2026-10-15 16:00:00',
        'completed',
        '2026-10-15 16:00:01',
      );
      await question(
        connection,
        a1,
        old,
        5,
        '2026-10-16 15:59:59',
        'failed',
        '2026-10-16 16:00:00',
      );
      await question(
        connection,
        a1,
        old,
        7,
        '2026-10-16 16:00:00',
        'completed',
        '2026-10-16 16:00:02',
      );
      await question(connection, a2, fresh, 1, '2026-10-17 15:59:59.999999', 'accepted', null);
      await question(
        connection,
        a2,
        fresh,
        3,
        '2026-10-17 16:00:00',
        'completed',
        '2026-10-17 16:00:01',
      );
      await question(
        connection,
        b,
        other,
        1,
        '2026-10-17 00:00:00',
        'completed',
        '2026-10-17 00:00:00.500000',
      );
      const task = uuid(),
        staleTask = uuid(),
        author = uuid();
      for (const [taskId, version] of [
        [task, 1],
        [staleTask, 2],
      ] as const) {
        await connection.execute(
          `INSERT INTO assistant_improvement (id, merchant_id, assistant_id, version, reason, question, expected_answer, notes, published_release_id, published_task_version, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'missing_information', 'PRIVATE_TEST_QUESTION', 'PRIVATE_TEST_EXPECTED', '', ?, 1, ?, ?, '2026-10-16 00:00:00', '2026-10-16 00:00:00')`,
          [taskId, aId, a1.id, version, a1.release, author, author],
        );
      }
      for (const [state, verdict] of [
        ['completed', 'pass'],
        ['completed', 'fail'],
        ['completed', null],
        ['failed', null],
        ['pending', null],
      ] as const) {
        await connection.execute(
          `INSERT INTO assistant_evaluation_run (id, merchant_id, assistant_id, improvement_id, task_version, draft_revision, facts_hash, question, expected_answer, state, verdict, prompt_template_version, model_policy_version, created_by, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, 'PRIVATE_TEST_QUESTION', 'PRIVATE_TEST_EXPECTED', ?, ?, 'synthetic', 'synthetic', ?, '2026-10-16 00:00:00')`,
          [uuid(), aId, a1.id, task, randomBytes(32), state, verdict, author],
        );
      }
      await connection.execute(
        `INSERT INTO job (id, merchant_id, type, dedup_key, payload, state, last_error_code, run_after, created_at, updated_at) VALUES (?, ?, 'conversation.turn', ?, '{"private":"DO_NOT_EXPORT"}', 'failed', 'synthetic_failure', '2026-10-16 00:00:00', '2026-10-16 00:00:00', '2026-10-16 00:00:00')`,
        [uuid(), aId, randomBytes(32)],
      );
    } finally {
      await connection.end();
    }

    const repository = new MySqlPlatformAnalyticsRepository(database);
    const scoped = await repository.analytics(range, aId!.toString('hex'));
    expect(scoped.inventory).toMatchObject({ merchants: 1, assistants: 2, publishedAssistants: 2 });
    expect(scoped.usage).toEqual({
      sessions: 1,
      questions: 4,
      completed: 2,
      failed: 1,
      pending: 1,
      meanResponseMs: 1500,
    });
    expect(scoped.daily).toEqual([
      {
        day: '2026-10-16',
        newMerchants: 1,
        sessions: 1,
        questions: 2,
        completed: 1,
        failed: 1,
        pending: 0,
        meanResponseMs: 1000,
      },
      {
        day: '2026-10-17',
        newMerchants: 0,
        sessions: 0,
        questions: 2,
        completed: 1,
        failed: 0,
        pending: 1,
        meanResponseMs: 2000,
      },
    ]);
    expect(scoped.quality).toEqual({
      improvements: 2,
      publishedImprovements: 1,
      evaluations: 5,
      evaluationCompleted: 3,
      evaluationFailed: 1,
      evaluationPending: 1,
      verdictPass: 1,
      verdictFail: 1,
      unreviewed: 1,
    });
    expect(scoped.errors).toHaveLength(2);
    expect(scoped.errors.map((item) => item.total)).toEqual([1, 1]);
    expect(JSON.stringify(scoped)).not.toMatch(/PRIVATE_|DO_NOT_EXPORT|SYNTHETIC_ANSWER/u);
    const list = await repository.merchants(range, { merchantId: aId!.toString('hex') });
    expect(list.total).toBe(1);
    expect(list.items[0]?.questions).toBe(4);
    expect(list.items[0]?.sessions).toBe(1);
    const assistants = await repository.assistants(range, aId!.toString('hex'));
    expect(assistants.total).toBe(2);
    expect(assistants.items.map((item) => item.questions)).toEqual([3, 1]);
    const other = await repository.analytics(range, bId!.toString('hex'));
    expect(other.usage.questions).toBe(1);
    expect(other.quality.evaluations).toBe(0);
    await new MySqlPlatformProvisioningRepository(database).setMerchantPaused({
      merchantId: aId!.toString('hex'),
      paused: true,
      operatorId: 'analytics_test',
      reason: '合成数据验收：暂停商家后保留历史用量',
    });
    const paused = await repository.analytics(range, aId!.toString('hex'));
    expect(paused.inventory.pausedMerchants).toBe(1);
    expect(paused.usage.questions).toBe(4);
    expect(
      (await repository.merchants(range, { merchantId: aId!.toString('hex'), activity: 'used' }))
        .total,
    ).toBe(1);
    expect(
      (await repository.merchants(range, { merchantId: aId!.toString('hex'), activity: 'unused' }))
        .total,
    ).toBe(0);
  });

  it('paginates more than fifty merchants with full count, no duplication and literal wildcard search', async () => {
    const connection = await database.openConnection();
    const prefix = `OPS_EMPTY_${randomBytes(6).toString('hex')}`;
    try {
      for (let index = 0; index < 61; index++)
        await merchant(connection, `${prefix}_${index === 0 ? '%_!' : index}`);
    } finally {
      await connection.end();
    }
    const repository = new MySqlPlatformAnalyticsRepository(database);
    const pages = await Promise.all(
      [1, 2, 3, 4].map((page) => repository.merchants(range, { search: prefix }, page)),
    );
    expect(pages.map((page) => page.total)).toEqual([61, 61, 61, 61]);
    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 20, 1]);
    expect(new Set(pages.flatMap((page) => page.items.map((item) => item.id))).size).toBe(61);
    expect((await repository.merchants(range, { search: `${prefix}_%_!` })).total).toBe(1);
    expect((await repository.analytics(range)).inventory.merchants).toBeGreaterThanOrEqual(61);
    expect((await repository.merchants(range, { search: prefix, activity: 'unused' })).total).toBe(
      61,
    );
  });
});
