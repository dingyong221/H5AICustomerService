import { describe, expect, it, vi } from 'vitest';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  MySqlConversationTurnJobRepository,
  type ConversationTurnClaim,
} from '../src/conversation-turn-job-repository.js';

const id = (fill: string) => Buffer.from(fill.repeat(16), 'hex');
const jobId = id('11');
const merchantId = id('22');
const assistantId = id('33');
const sessionId = id('44');
const releaseId = id('55');
const turnId = id('66');
const visitorMessageId = id('77');
const now = new Date('2026-09-24T00:00:00.000Z');
const resultHeader = { affectedRows: 1 } as ResultSetHeader;
const payload = {
  merchantId: merchantId.toString('hex'),
  assistantId: assistantId.toString('hex'),
  sessionId: sessionId.toString('hex'),
  releaseId: releaseId.toString('hex'),
  turnId: `t_${turnId.toString('hex')}`,
};
const facts = {
  displayName: '蓝天客服',
  industry: '家庭服务',
  businessScope: '空调清洗',
  materialsSummary: '提供挂机清洗',
  pricingSummary: '100 元/台',
  promotionSummary: '暂无优惠',
  insufficientInfoMessage: '请联系商家确认',
};

const repositoryWith = (
  handler: (statement: string, values: readonly unknown[]) => Promise<unknown>,
) => {
  const calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const connection = {
    execute: async (statement: string, values: readonly unknown[] = []) => {
      calls.push({ statement, values });
      return handler(statement, values);
    },
    beginTransaction: vi.fn(async () => undefined),
    commit,
    rollback,
    end: vi.fn(async () => undefined),
  } as unknown as Connection;
  const database = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  } satisfies DatabaseConnectionConfig;
  return { repository: new MySqlConversationTurnJobRepository(database), calls, commit, rollback };
};

const acceptedClaim: ConversationTurnClaim = {
  jobId: jobId.toString('hex'),
  leaseOwner: 'worker_test_01',
  claimGeneration: '1',
  leaseUntil: new Date(now.getTime() + 120_000),
  payloadVersion: 0,
  merchantId: merchantId.toString('hex'),
  assistantId: assistantId.toString('hex'),
  sessionId: sessionId.toString('hex'),
  releaseId: releaseId.toString('hex'),
  turnId: turnId.toString('hex'),
  visitorMessageId: visitorMessageId.toString('hex'),
  question: '清洗多少钱？',
  facts,
  context: [],
};

describe('MySQL conversation turn jobs', () => {
  it('leases one tenant-scoped job with pinned release facts and completed context', async () => {
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('FROM job')) {
        return [[{ id: jobId, merchant_id: merchantId, payload, state: 'pending', attempt: 0, max_attempts: 5, claim_generation: '0', model_outcome: 'none' }], []];
      }
      if (statement.includes('FROM conversation_session')) {
        return [
          [
            {
              merchant_id: merchantId,
              assistant_id: assistantId,
              release_id: releaseId,
              active_turn_id: turnId,
              next_sequence: 2,
              status: 'active',
              expires_at: new Date(now.getTime() + 60_000),
              merchant_status: 'active',
              assistant_status: 'active',
              config_snapshot: { ...facts, humanContact: '已发布人工说明：微信 old_support' },
            },
          ],
          [],
        ];
      }
      if (statement.includes("role = 'visitor'")) {
        return [
          [{ id: visitorMessageId, seq_no: 1, content: '清洗多少钱？', state: 'accepted' }],
          [],
        ];
      }
      if (statement.includes("state = 'completed'")) {
        return [
          [
            { role: 'assistant', content: '你好' },
            { role: 'visitor', content: '你好' },
          ],
          [],
        ];
      }
      return [resultHeader, []];
    });
    const claim = await repository.claimNext(now, 'worker_test_01');
    expect(claim).toMatchObject({
      jobId: jobId.toString('hex'),
      releaseId: releaseId.toString('hex'),
      facts: { humanContact: '已发布人工说明：微信 old_support' },
      question: '清洗多少钱？',
      context: [
        { role: 'visitor', content: '你好' },
        { role: 'assistant', content: '你好' },
      ],
    });
    expect(calls[0]?.statement).toContain('FOR UPDATE SKIP LOCKED');
    expect(calls.some((call) => call.statement.includes("SET state = 'processing'"))).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('fails a job and releases the session when pinned facts are missing', async () => {
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('FROM job')) {
        return [[{ id: jobId, merchant_id: merchantId, payload, state: 'pending', attempt: 0, max_attempts: 5, claim_generation: '0', model_outcome: 'none' }], []];
      }
      if (statement.includes('FROM conversation_session')) {
        return [
          [
            {
              merchant_id: merchantId,
              assistant_id: assistantId,
              release_id: releaseId,
              active_turn_id: turnId,
              next_sequence: 2,
              status: 'active',
              expires_at: new Date(now.getTime() + 60_000),
              merchant_status: 'active',
              assistant_status: 'active',
              config_snapshot: {},
            },
          ],
          [],
        ];
      }
      if (statement.includes("role = 'visitor'")) {
        return [[{ id: visitorMessageId, seq_no: 1, content: '问题', state: 'accepted' }], []];
      }
      return [resultHeader, []];
    });
    await expect(repository.claimNext(now, 'worker_test_01')).resolves.toBeNull();
    expect(
      calls.some(
        (call) =>
          call.statement.includes("SET state = 'failed'") &&
          call.values[0] === 'KNOWLEDGE_UNAVAILABLE',
      ),
    ).toBe(true);
    expect(calls.some((call) => call.statement.includes('SET active_turn_id = NULL'))).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('atomically records the answer and clears the active turn only for its lease owner', async () => {
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('FROM job')) return [[{
        id: jobId, merchant_id: merchantId, payload, state: 'processing',
        lease_owner: acceptedClaim.leaseOwner, lease_until: acceptedClaim.leaseUntil,
        claim_generation: acceptedClaim.claimGeneration, model_outcome: 'none', model_attempt_id: null,
      }], []];
      if (statement.includes('SELECT id FROM message')) return [[{ id: visitorMessageId }], []];
      if (statement.includes('SELECT cs.active_turn_id')) {
        return [
          [
            {
              active_turn_id: turnId,
              next_sequence: 2,
              merchant_status: 'active',
              assistant_status: 'active',
            },
          ],
          [],
        ];
      }
      return [resultHeader, []];
    });
    await repository.complete(acceptedClaim, '根据资料，100 元/台。', now);
    expect(
      calls.some(
        (call) =>
          call.statement.includes('INSERT INTO message') &&
          call.statement.includes("'assistant', 'completed'"),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.statement.includes('next_sequence = ?') && call.values[0] === 3),
    ).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });
});
