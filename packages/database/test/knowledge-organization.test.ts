import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { safeKnowledgeRetry } from '@h5cs/domain';
import {
  MySqlKnowledgeOrganizationRepository,
  parseKnowledgeResult,
} from '../src/knowledge-organization-repository.js';
import { decodeKnowledgePayload, knowledgeHash } from '../src/knowledge-organization-contract.js';
import type { DatabaseConnectionConfig } from '../src/config.js';
const scope = { merchantId: 'a'.repeat(32), assistantId: 'b'.repeat(32), userId: 'c'.repeat(32) };
describe('knowledge fail-closed contracts without SQL execution', () => {
  it('keeps unknown/dispatched/succeeded finalization out of explicit retry', () => {
    for (const state of ['pending', 'processing', 'completed', 'cancelled'])
      for (const outcome of ['none', 'failed', 'unknown'] as const)
        expect(safeKnowledgeRetry(state, outcome)).toBe(false);
    for (const outcome of ['dispatched', 'unknown', 'succeeded'] as const)
      expect(safeKnowledgeRetry('failed', outcome)).toBe(false);
    for (const outcome of ['none', 'failed', 'not_dispatched'] as const)
      expect(safeKnowledgeRetry('failed', outcome)).toBe(true);
  });
  it('rejects old/unknown payload versions and duplicate or corrupt references', () => {
    const p = {
      schemaVersion: 1,
      handlerVersion: 'knowledge-organize-v1',
      merchantId: scope.merchantId,
      assistantId: scope.assistantId,
      requesterUserId: scope.userId,
      inputRevision: 1,
      requestHash: knowledgeHash('synthetic'),
      sources: [
        { id: 'd'.repeat(32), revision: 1, contentHash: knowledgeHash('原文'), name: '合成.txt' },
      ],
    };
    expect(decodeKnowledgePayload(p).inputRevision).toBe(1);
    for (const x of [
      { ...p, schemaVersion: 0 },
      { ...p, handlerVersion: 'conversation-v1' },
      { ...p, sources: [...p.sources, ...p.sources] },
      { ...p, inputRevision: 0 },
    ])
      expect(() => decodeKnowledgePayload(x)).toThrow();
    expect(() => parseKnowledgeResult({ summary: '', warnings: [] })).toThrow();
  });
  it('default disabled admission never opens the database', async () => {
    const openConnection = vi.fn();
    const database = {
      openConnection,
      summary: { host: 'isolated', database: 'fake', tlsRequested: false },
      toJSON: () => ({ host: 'isolated', database: 'fake', tlsRequested: false }),
    } as DatabaseConnectionConfig;
    const repo = new MySqlKnowledgeOrganizationRepository(database, false);
    await expect(
      repo.enqueue({
        ...scope,
        requestId: 'organize_' + 'e'.repeat(32),
        sourceIds: ['d'.repeat(32)],
        revision: 1,
        consent: true,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(openConnection).not.toHaveBeenCalled();
  });
  it('denies wrong editor before reading source text or inserting a job', async () => {
    const execute = vi.fn(async () => [[], []]);
    const c = {
      execute,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(async () => undefined),
      end: vi.fn(),
    } as unknown as Connection;
    const database = {
      openConnection: async () => c,
      summary: { host: 'isolated', database: 'fake', tlsRequested: false },
      toJSON: () => ({ host: 'isolated', database: 'fake', tlsRequested: false }),
    };
    const repo = new MySqlKnowledgeOrganizationRepository(database, true);
    await expect(
      repo.enqueue({
        ...scope,
        requestId: 'organize_' + 'e'.repeat(32),
        sourceIds: ['d'.repeat(32)],
        revision: 1,
        consent: true,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(c.rollback).toHaveBeenCalledTimes(1);
  });
});
