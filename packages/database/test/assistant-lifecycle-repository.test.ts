import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  AssistantIdempotencyConflictError,
  AssistantLifecyclePersistenceError,
  AssistantPublishValidationError,
  AssistantRevisionConflictError,
  toAssistantId,
  toMerchantId,
  toMerchantUserId,
  toOnboardingSessionId,
} from '@h5cs/domain';
import type { AssistantDraftConfig } from '@h5cs/domain';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import { MySqlAssistantLifecycleRepository } from '../src/assistant-lifecycle-repository.js';

type SqlCall = Readonly<{ statement: string; values: readonly unknown[] }>;

const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const now = new Date('2026-09-21T12:00:00.000Z');
const later = new Date('2026-09-22T12:00:00.000Z');
const merchantId = toMerchantId('11'.repeat(16));
const merchantUserId = toMerchantUserId('22'.repeat(16));
const onboardingSessionId = toOnboardingSessionId('33'.repeat(16));
const assistantId = toAssistantId('44'.repeat(16));
const releaseId = '55'.repeat(16);
const knowledgeRevisionId = 'aa'.repeat(16);
const activeReleaseId = Buffer.from('99'.repeat(16), 'hex');
const publicSlug = 'a-abcdefghijklmnop';

const idem = {
  actorScopeDigest: digest(1),
  keyDigest: digest(2),
  requestHash: digest(3),
  expiresAt: later,
};

const resultHeader = (affectedRows = 1): ResultSetHeader => ({ affectedRows }) as ResultSetHeader;

const sampleDraft: AssistantDraftConfig = {
  industry: 'home-service',
  businessScope: '空调清洗服务咨询',
  materialsSummary: '空调清洗服务手册',
  pricingSummary: '挂机清洗：100 CNY',
  promotionSummary: '已确认暂无优惠信息',
  welcomeMessage: '你好，我是蓝天服务客服。',
  insufficientInfoMessage: '当前资料不足，请联系商家确认。',
};
const sampleContentHash = createHash('sha256')
  .update(JSON.stringify(sampleDraft), 'utf8')
  .digest('hex');

const managementRow = (overrides: Record<string, unknown> = {}) => ({
  assistant_id: Buffer.from(assistantId, 'hex'),
  merchant_id: Buffer.from(merchantId, 'hex'),
  display_name: '蓝天服务客服',
  public_slug: publicSlug,
  status: 'draft_only',
  draft_revision: 1,
  config: sampleDraft,
  validation: {
    publishable: true,
    confirmedRevision: 1,
    knowledgeRevisionId,
    contentHash: sampleContentHash,
  },
  active_release_id: null,
  created_at: now,
  updated_at: now,
  membership_status: 'active',
  merchant_status: 'active',
  ...overrides,
});

const repositoryWith = (
  handler: (statement: string, values: readonly unknown[]) => Promise<unknown>,
  ids: readonly Buffer[] = [],
  current: { assistant_id: Buffer | null; has_history: number } = {
    assistant_id: null,
    has_history: 0,
  },
) => {
  const calls: SqlCall[] = [];
  const beginTransaction = vi.fn(async () => undefined);
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const connection = {
    execute: async (statement: string, values: readonly unknown[] = []) => {
      calls.push({ statement, values });
      if (statement.startsWith('SELECT id FROM merchant WHERE'))
        return [[{ id: Buffer.from(merchantId, 'hex') }], []];
      if (statement.includes('AS has_history')) return [[current], []];
      if (statement.includes('FROM assistant_publication_governance'))
        return [
          [
            {
              preview_id: Buffer.from('ab'.repeat(16), 'hex'),
              preview_revision: 1,
              preview_verdict: 'pass',
              preview_facts_hash: createHash('sha256')
                .update(JSON.stringify({ displayName: '蓝天服务客服', ...sampleDraft }))
                .digest(),
            },
          ],
          [],
        ];
      return handler(statement, values);
    },
    beginTransaction,
    commit,
    rollback,
    end,
  } as unknown as Connection;
  const config: DatabaseConnectionConfig = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  };
  const queue = [...ids];
  return {
    repository: new MySqlAssistantLifecycleRepository(config, {
      id: () => queue.shift() ?? Buffer.from('fe'.repeat(16), 'hex'),
      slug: () => publicSlug,
    }),
    calls,
    beginTransaction,
    commit,
    rollback,
  };
};

describe('MySQL assistant lifecycle repository', () => {
  it('adds safe display/slug facts and a composite active-release mapping', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'migrations/0005_striped_jack_murdock.sql'),
      'utf8',
    );

    expect(sql).toContain('`display_name` varchar(200) NOT NULL');
    expect(sql).toContain('`public_slug_digest` binary(32) NOT NULL');
    expect(sql).toContain('`draft_revision` int unsigned NOT NULL');
    expect(sql).toContain('fk_assistant_active_release_assistant');
    expect(sql).toContain('fk_assistant_active_release_release');
    expect(sql).toContain('ENGINE=InnoDB');
  });

  it('creates one assistant and draft from a complete locked onboarding session', async () => {
    const { repository, calls, commit } = repositoryWith(
      async (statement) => {
        if (statement.includes('SELECT s.answers')) {
          return [
            [
              {
                answers: {
                  businessName: '蓝天服务',
                  businessDescription: '空调清洗服务咨询',
                  industryCode: 'home-service',
                  materials: [{ summary: '空调清洗服务手册' }],
                  pricingPolicy: {
                    availability: 'provided',
                    facts: [{ offeringName: '挂机清洗', amount: '100', currency: 'CNY' }],
                  },
                  promotionPolicy: { availability: 'none_confirmed', facts: [] },
                  insufficientFactPolicy: 'contact_merchant',
                  merchantConfirmed: true,
                },
                missing_items: [],
                version: 7,
              },
            ],
            [],
          ];
        }
        return [resultHeader(), []];
      },
      [
        Buffer.from('66'.repeat(16), 'hex'),
        Buffer.from(assistantId, 'hex'),
        Buffer.from('77'.repeat(16), 'hex'),
      ],
    );

    await expect(
      repository.generateDraftFromOnboarding({
        merchantUserId,
        merchantId,
        onboardingSessionId,
        idempotency: idem,
        now,
      }),
    ).resolves.toMatchObject({
      assistantId,
      merchantId,
      displayName: '蓝天服务客服',
      publicSlug,
      status: 'draft_only',
      draftRevision: 1,
      draft: {
        industry: 'home-service',
        materialsSummary: '空调清洗服务手册',
        pricingSummary: '挂机清洗：100 CNY',
        promotionSummary: '已确认暂无优惠信息',
      },
    });
    expect(publicSlug).toMatch(/^[a-z0-9-]{1,63}$/u);

    expect(calls[0]?.statement).toMatch(/SELECT id FROM merchant[\s\S]*FOR UPDATE/u);
    expect(
      calls.filter((call) => call.statement.includes('INSERT INTO merchant_assistant')),
    ).toHaveLength(1);
    const creationCalls = calls.filter(
      (call) =>
        !call.statement.startsWith('SELECT id FROM merchant WHERE') &&
        !call.statement.includes('AS has_history') &&
        !call.statement.includes('INSERT INTO merchant_assistant'),
    );
    expect(creationCalls[0]?.statement).toMatch(/INSERT INTO idempotency_record/u);
    expect(creationCalls[1]?.statement).toMatch(/state = 'generating'[\s\S]*FOR UPDATE/u);
    expect(creationCalls[2]?.statement).toMatch(/INSERT INTO assistant/u);
    expect(creationCalls[3]?.statement).toMatch(/INSERT INTO assistant_draft/u);
    expect(creationCalls[3]?.values).toContain(
      JSON.stringify({ publishable: false, reason: 'knowledge_not_verified' }),
    );
    expect(creationCalls[4]?.statement).toMatch(/state = 'manageable'/u);
    expect(creationCalls[5]?.statement).toMatch(/state = 'succeeded'/u);
    expect(creationCalls[6]?.statement).toMatch(/INSERT INTO outbox_event/u);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('reuses the current assistant and never overwrites a different incoming draft', async () => {
    const { repository, calls, commit } = repositoryWith(
      async (statement) => {
        if (statement.includes('FROM merchant_membership mm'))
          return [[{ merchant_id: Buffer.from(merchantId, 'hex') }], []];
        if (statement.includes('FROM assistant a')) return [[managementRow()], []];
        return [resultHeader(), []];
      },
      [],
      { assistant_id: Buffer.from(assistantId, 'hex'), has_history: 1 },
    );
    const result = await repository.createManualDraft({
      merchantId,
      merchantUserId,
      displayName: '另一个名称',
      draft: { ...sampleDraft, pricingSummary: '不同的新价格' },
      idempotency: idem,
      now,
    });
    expect(result).toMatchObject({
      assistantId,
      displayName: '蓝天服务客服',
      draft: sampleDraft,
      reusedExisting: true,
    });
    expect(
      calls.some((call) =>
        /INSERT INTO assistant(?:\s|_draft)|UPDATE assistant(?:\s|_draft)|INSERT INTO outbox_event/u.test(
          call.statement,
        ),
      ),
    ).toBe(false);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('stops creation when retained assistant rows have no reviewed current binding', async () => {
    const { repository, calls, rollback } = repositoryWith(
      async (statement) => {
        if (statement.includes('FROM merchant_membership mm'))
          return [[{ merchant_id: Buffer.from(merchantId, 'hex') }], []];
        return [resultHeader(), []];
      },
      [],
      { assistant_id: null, has_history: 1 },
    );
    await expect(
      repository.createManualDraft({
        merchantId,
        merchantUserId,
        displayName: '不能新增',
        draft: sampleDraft,
        idempotency: idem,
        now,
      }),
    ).rejects.toBeInstanceOf(AssistantLifecyclePersistenceError);
    expect(calls.some((call) => call.statement.startsWith('INSERT INTO assistant'))).toBe(false);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('creates a merchant-scoped manual draft but keeps it unpublishable', async () => {
    const { repository, calls, commit } = repositoryWith(
      async (statement) => {
        if (statement.includes('FROM merchant_membership mm'))
          return [[{ merchant_id: Buffer.from(merchantId, 'hex') }], []];
        return [resultHeader(), []];
      },
      [
        Buffer.from('66'.repeat(16), 'hex'),
        Buffer.from(assistantId, 'hex'),
        Buffer.from('77'.repeat(16), 'hex'),
      ],
    );

    await expect(
      repository.createManualDraft({
        merchantUserId,
        merchantId,
        displayName: '蓝天服务客服',
        draft: managementRow().config as AssistantDraftConfig,
        idempotency: idem,
        now,
      }),
    ).resolves.toMatchObject({ assistantId, status: 'draft_only', draftRevision: 1 });

    expect(calls[0]?.statement).toMatch(/SELECT id FROM merchant[\s\S]*FOR UPDATE/u);
    expect(
      calls.filter((call) => call.statement.includes('INSERT INTO merchant_assistant')),
    ).toHaveLength(1);
    const creationCalls = calls.filter(
      (call) =>
        !call.statement.startsWith('SELECT id FROM merchant WHERE') &&
        !call.statement.includes('AS has_history') &&
        !call.statement.includes('INSERT INTO merchant_assistant'),
    );
    expect(creationCalls[0]?.statement).toMatch(/merchant_membership[\s\S]*FOR UPDATE/u);
    expect(creationCalls[1]?.statement).toMatch(/INSERT INTO idempotency_record/u);
    expect(creationCalls[2]?.statement).toMatch(/INSERT INTO assistant/u);
    expect(creationCalls[3]?.values).toContain(
      JSON.stringify({ publishable: false, reason: 'knowledge_not_verified' }),
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it('records merchant-confirmed text as ready knowledge for the exact draft revision', async () => {
    const { repository, calls, commit } = repositoryWith(
      async (statement) => {
        if (statement.includes('FROM assistant a') && statement.includes('FOR UPDATE')) {
          return [
            [
              managementRow({
                validation: { publishable: false, reason: 'knowledge_not_verified' },
              }),
            ],
            [],
          ];
        }
        return [resultHeader(), []];
      },
      [
        Buffer.from('bb'.repeat(16), 'hex'),
        Buffer.from(knowledgeRevisionId, 'hex'),
        Buffer.from('cc'.repeat(16), 'hex'),
      ],
    );

    await expect(
      repository.confirmDraftKnowledge({
        merchantUserId,
        merchantId,
        assistantId,
        expectedDraftRevision: 1,
        now,
      }),
    ).resolves.toEqual({ knowledgeRevisionId, draftRevision: 1 });
    expect(calls[1]?.statement).toContain('INSERT INTO knowledge_source');
    expect(calls[2]?.statement).toContain('INSERT INTO knowledge_revision');
    expect(calls[2]?.values).toContain('merchant-confirmed-v1');
    expect(calls[3]?.statement).toContain('UPDATE assistant_draft');
    expect(calls[3]?.values[0]).toContain(`"knowledgeRevisionId":"${knowledgeRevisionId}"`);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('reuses a confirmed ready knowledge revision instead of creating a duplicate', async () => {
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('FROM assistant a') && statement.includes('FOR UPDATE')) {
        return [[managementRow()], []];
      }
      if (statement.includes('FROM knowledge_revision kr')) {
        return [[{ id: Buffer.from(knowledgeRevisionId, 'hex') }], []];
      }
      throw new Error('unexpected write after confirmation');
    });

    await expect(
      repository.confirmDraftKnowledge({
        merchantUserId,
        merchantId,
        assistantId,
        expectedDraftRevision: 1,
        now,
      }),
    ).resolves.toEqual({ knowledgeRevisionId, draftRevision: 1 });
    expect(calls).toHaveLength(2);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('returns the original generated assistant after an idempotency race', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('INSERT INTO idempotency_record')) throw duplicate;
      if (statement.includes('SELECT request_hash')) {
        return [
          [
            {
              request_hash: Buffer.from(idem.requestHash),
              state: 'succeeded',
              resource_id: Buffer.from(assistantId, 'hex'),
              response_body: { assistantId },
            },
          ],
          [],
        ];
      }
      if (statement.includes('FROM assistant a')) return [[managementRow()], []];
      throw new Error('unexpected SQL');
    });

    await expect(
      repository.generateDraftFromOnboarding({
        merchantUserId,
        merchantId,
        onboardingSessionId,
        idempotency: idem,
        now,
      }),
    ).resolves.toMatchObject({ assistantId, draftRevision: 1 });
    expect(calls.some((call) => call.statement.includes('INSERT INTO assistant'))).toBe(false);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rejects an idempotency key reused with another request hash', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const { repository } = repositoryWith(async (statement) => {
      if (statement.includes('INSERT INTO idempotency_record')) throw duplicate;
      return [
        [
          {
            request_hash: Buffer.from(digest(99)),
            state: 'succeeded',
            resource_id: Buffer.from(assistantId, 'hex'),
            response_body: { assistantId },
          },
        ],
        [],
      ];
    });

    await expect(
      repository.generateDraftFromOnboarding({
        merchantUserId,
        merchantId,
        onboardingSessionId,
        idempotency: idem,
        now,
      }),
    ).rejects.toBeInstanceOf(AssistantIdempotencyConflictError);
  });

  it('uses tenant-qualified management reads and rejects stale draft revisions', async () => {
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('FOR UPDATE')) return [[managementRow({ draft_revision: 2 })], []];
      return [[], []];
    });

    await expect(repository.findManagementSnapshot(merchantId, assistantId)).resolves.toBeNull();
    await expect(
      repository.saveDraft({
        merchantUserId,
        merchantId,
        assistantId,
        expectedRevision: 1,
        draft: managementRow().config as AssistantDraftConfig,
        now,
      }),
    ).rejects.toBeInstanceOf(AssistantRevisionConflictError);
    expect(calls[0]?.statement).toMatch(/a\.merchant_id = \? AND a\.id = \?/u);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('saves a draft with an optimistic revision without changing active release', async () => {
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('FOR UPDATE')) {
        return [[managementRow({ active_release_id: activeReleaseId, status: 'active' })], []];
      }
      return [resultHeader(), []];
    });

    await expect(
      repository.saveDraft({
        merchantUserId,
        merchantId,
        assistantId,
        expectedRevision: 1,
        draft: {
          industry: 'home-service',
          businessScope: '更新后的业务范围',
          materialsSummary: '空调清洗服务手册',
          pricingSummary: '挂机清洗：100 CNY',
          promotionSummary: '已确认暂无优惠信息',
          welcomeMessage: '欢迎咨询。',
          insufficientInfoMessage: '资料不足时请联系商家。',
        },
        now,
      }),
    ).resolves.toMatchObject({
      draftRevision: 2,
      activeReleaseId: activeReleaseId.toString('hex'),
    });
    expect(calls[1]?.statement).toMatch(
      /WHERE merchant_id = \? AND assistant_id = \? AND revision = \?/u,
    );
    expect(calls[2]?.statement).not.toMatch(/active_release_id/u);
  });

  it('publishes an immutable monotonic release and switches the active mapping atomically', async () => {
    const { repository, calls, commit } = repositoryWith(
      async (statement) => {
        if (statement.includes('FROM assistant a') && statement.includes('FOR UPDATE')) {
          return [[managementRow({ active_release_id: activeReleaseId, status: 'active' })], []];
        }
        if (statement.includes('FROM knowledge_revision kr')) {
          return [[{ id: Buffer.from(knowledgeRevisionId, 'hex') }], []];
        }
        if (statement.includes('SELECT release_no')) return [[{ release_no: 2 }], []];
        return [resultHeader(), []];
      },
      [
        Buffer.from('66'.repeat(16), 'hex'),
        Buffer.from(releaseId, 'hex'),
        Buffer.from('77'.repeat(16), 'hex'),
      ],
    );

    await expect(
      repository.publish({
        merchantUserId,
        merchantId,
        assistantId,
        expectedDraftRevision: 1,
        promptTemplateVersion: 'prompt-v1',
        retrievalPolicyVersion: 'retrieval-v1',
        modelPolicyVersion: 'model-v1',
        idempotency: idem,
        now,
      }),
    ).resolves.toMatchObject({ releaseId, releaseNo: 3, draftRevision: 1, status: 'active' });

    expect(calls[1]?.statement).toMatch(/merchant_membership[\s\S]*FOR UPDATE/u);
    expect(calls[2]?.statement).toMatch(/knowledge_revision[\s\S]*status = 'ready'/u);
    expect(calls[3]?.statement).toContain('assistant_publication_governance');
    expect(calls[4]?.statement).toMatch(/ORDER BY release_no DESC[\s\S]*FOR UPDATE/u);
    expect(calls[6]?.statement).toMatch(/INSERT INTO assistant_release/u);
    expect(calls[7]?.statement).toMatch(/INSERT INTO assistant_active_release/u);
    expect(calls[8]?.statement).toMatch(/SET active_release_id = \?, status = 'active'/u);
    expect(calls[9]?.statement).toContain('UPDATE assistant_improvement');
    expect(calls[9]?.statement).toContain('r.task_version = i.version');
    expect(calls[9]?.statement).toContain('r.facts_hash = ?');
    expect(calls[9]?.values).toEqual([
      Buffer.from(releaseId, 'hex'),
      now,
      Buffer.from(merchantId, 'hex'),
      Buffer.from(assistantId, 'hex'),
      1,
      Buffer.from(sampleContentHash, 'hex'),
      'prompt-v1',
      'model-v1',
    ]);
    expect(calls[10]?.statement).toMatch(/state = 'succeeded'/u);
    expect(calls[11]?.statement).toMatch(/INSERT INTO outbox_event/u);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('does not publish an unverified manual draft', async () => {
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('FROM assistant a') && statement.includes('FOR UPDATE')) {
        return [
          [managementRow({ validation: { publishable: false, reason: 'knowledge_not_verified' } })],
          [],
        ];
      }
      return [resultHeader(), []];
    });

    await expect(
      repository.publish({
        merchantUserId,
        merchantId,
        assistantId,
        expectedDraftRevision: 1,
        promptTemplateVersion: 'prompt-v1',
        retrievalPolicyVersion: 'retrieval-v1',
        modelPolicyVersion: 'model-v1',
        idempotency: idem,
        now,
      }),
    ).rejects.toBeInstanceOf(AssistantPublishValidationError);
    expect(calls.some((call) => call.statement.includes('INSERT INTO assistant_release'))).toBe(
      false,
    );
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('does not publish when confirmed knowledge is no longer ready', async () => {
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('FROM assistant a') && statement.includes('FOR UPDATE')) {
        return [[managementRow()], []];
      }
      if (statement.includes('FROM knowledge_revision kr')) return [[], []];
      return [resultHeader(), []];
    });

    await expect(
      repository.publish({
        merchantUserId,
        merchantId,
        assistantId,
        expectedDraftRevision: 1,
        promptTemplateVersion: 'prompt-v1',
        retrievalPolicyVersion: 'retrieval-v1',
        modelPolicyVersion: 'model-v1',
        idempotency: idem,
        now,
      }),
    ).rejects.toBeInstanceOf(AssistantPublishValidationError);
    expect(calls.some((call) => call.statement.includes('INSERT INTO assistant_release'))).toBe(
      false,
    );
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('returns the same release for a repeated publish idempotency key', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('INSERT INTO idempotency_record')) throw duplicate;
      if (statement.includes('FROM assistant a') && statement.includes('FOR UPDATE')) {
        return [
          [managementRow({ status: 'active', active_release_id: Buffer.from(releaseId, 'hex') })],
          [],
        ];
      }
      if (statement.includes('SELECT request_hash')) {
        return [
          [
            {
              request_hash: Buffer.from(idem.requestHash),
              state: 'succeeded',
              resource_id: Buffer.from(releaseId, 'hex'),
              response_body: { releaseId },
            },
          ],
          [],
        ];
      }
      if (statement.includes('FROM assistant_release')) {
        return [
          [
            {
              release_id: Buffer.from(releaseId, 'hex'),
              merchant_id: Buffer.from(merchantId, 'hex'),
              assistant_id: Buffer.from(assistantId, 'hex'),
              release_no: 3,
              draft_revision: 1,
              created_at: now,
              activated_at: now,
            },
          ],
          [],
        ];
      }
      throw new Error('unexpected SQL');
    });

    await expect(
      repository.publish({
        merchantUserId,
        merchantId,
        assistantId,
        expectedDraftRevision: 1,
        promptTemplateVersion: 'prompt-v1',
        retrievalPolicyVersion: 'retrieval-v1',
        modelPolicyVersion: 'model-v1',
        idempotency: idem,
        now,
      }),
    ).resolves.toMatchObject({ releaseId, releaseNo: 3, draftRevision: 1 });
    expect(calls.some((call) => call.statement.includes('INSERT INTO assistant_release'))).toBe(
      false,
    );
    expect(rollback).toHaveBeenCalledOnce();
    const authorization = calls.findIndex(
      (call) =>
        call.statement.includes('merchant_membership') && call.statement.includes('FOR UPDATE'),
    );
    const cachedSuccess = calls.findIndex((call) => call.statement.includes('SELECT request_hash'));
    expect(authorization).toBeGreaterThan(0);
    expect(cachedSuccess).toBeGreaterThan(authorization);
    expect(calls[authorization]?.values).toEqual([
      Buffer.from(merchantUserId, 'hex'),
      Buffer.from(merchantId, 'hex'),
      Buffer.from(assistantId, 'hex'),
    ]);
  });

  it('rejects duplicate publish recovery before reading cached success when membership or merchant authorization is no longer active', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('INSERT INTO idempotency_record')) throw duplicate;
      if (statement.includes('FROM assistant a') && statement.includes('FOR UPDATE'))
        return [[], []];
      throw new Error('Cached release must not be read after failed current authorization');
    });
    await expect(
      repository.publish({
        merchantUserId,
        merchantId,
        assistantId,
        expectedDraftRevision: 1,
        promptTemplateVersion: 'prompt-v1',
        retrievalPolicyVersion: 'retrieval-v1',
        modelPolicyVersion: 'model-v1',
        idempotency: idem,
        now,
      }),
    ).rejects.toBeInstanceOf(AssistantPublishValidationError);
    expect(calls[1]?.statement).toContain("u.status = 'active'");
    expect(calls[1]?.statement).toContain("mm.status = 'active'");
    expect(calls[1]?.statement).toContain("m.status = 'active'");
    expect(
      calls.some(
        (call) =>
          call.statement.includes('SELECT request_hash') ||
          call.statement.includes('FROM assistant_release'),
      ),
    ).toBe(false);
    expect(rollback).toHaveBeenCalledTimes(2);
  });

  it('does not return a created assistant snapshot through duplicate generation recovery after revocation', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('INSERT INTO idempotency_record')) throw duplicate;
      if (statement.includes('SELECT request_hash'))
        return [
          [
            {
              request_hash: Buffer.from(idem.requestHash),
              state: 'succeeded',
              resource_id: Buffer.from(assistantId, 'hex'),
              response_body: { assistantId },
            },
          ],
          [],
        ];
      if (statement.includes('FROM assistant a') && statement.includes('FOR UPDATE'))
        return [[], []];
      throw new Error('Unauthorized management snapshot must not be read');
    });
    await expect(
      repository.generateDraftFromOnboarding({
        merchantUserId,
        merchantId,
        onboardingSessionId,
        idempotency: idem,
        now,
      }),
    ).rejects.toBeInstanceOf(AssistantLifecyclePersistenceError);
    expect(calls.filter((call) => call.statement.includes('SELECT request_hash'))).toHaveLength(1);
    expect(calls.at(-1)?.statement).toContain('merchant_membership');
    expect(calls.at(-1)?.statement).toContain('FOR UPDATE');
    expect(rollback).toHaveBeenCalledTimes(2);
  });

  it('returns only an active published public snapshot and unifies negative lookups as null', async () => {
    let returnPublic = true;
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('FROM assistant a') && returnPublic) {
        return [
          [
            {
              public_slug: publicSlug,
              release_id: Buffer.from(releaseId, 'hex'),
              merchant_name: '蓝天服务',
              display_name: '蓝天服务客服',
              config_snapshot: {
                displayName: '蓝天服务客服',
                industry: 'home-service',
                businessScope: '空调清洗服务咨询',
                materialsSummary: '空调清洗服务手册',
                pricingSummary: '挂机清洗：100 CNY',
                promotionSummary: '已确认暂无优惠信息',
                welcomeMessage: '你好，我是蓝天服务客服。',
                insufficientInfoMessage: '当前资料不足，请联系商家确认。',
              },
            },
          ],
          [],
        ];
      }
      return [[], []];
    });

    await expect(repository.findPublicSnapshot(publicSlug)).resolves.toMatchObject({
      publicAssistantId: publicSlug,
      releaseRef: releaseId,
      merchantName: '蓝天服务',
      humanContact: '',
      availability: 'online',
    });
    returnPublic = false;
    await expect(repository.findPublicSnapshot(publicSlug)).resolves.toBeNull();
    await expect(repository.findPublicSnapshot('A_INVALID_UPPERCASE')).resolves.toBeNull();
    expect(calls[0]?.statement).toMatch(
      /assistant_active_release[\s\S]*a\.status = 'active'[\s\S]*r\.status = 'active'[\s\S]*m\.status = 'active'/u,
    );
  });
});
