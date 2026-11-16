import { describe, it, expect, vi } from 'vitest';
import { MySqlAuthoringTaskRepository } from '../src/authoring-task-repository.js';
import { decodeAuthoringPayload } from '../src/authoring-task-contract.js';
import { knowledgeHash } from '../src/knowledge-organization-contract.js';
const scope = { merchantId: 'a'.repeat(32), assistantId: 'b'.repeat(32), userId: 'c'.repeat(32) },
  input = {
    requestId: 'authoring_' + 'd'.repeat(32),
    revision: 1,
    field: 'industry' as const,
    brief: '零售',
    currentText: ' 家居 ',
    consent: true as const,
  };
describe('persistent authoring fail closed', () => {
  it('disabled admissions and claims do not touch SQL', async () => {
    const openConnection = vi.fn(),
      summary = { host: 'fixture', database: 'fixture', tlsRequested: false },
      repo = new MySqlAuthoringTaskRepository(
        { openConnection, summary, toJSON: () => summary },
        { draftExpand: false, previewReply: false },
      );
    await expect(
      repo.enqueueDraftExpand({ ...scope, ...input, now: new Date() }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(
      await repo.claimNext(new Date(), 'test_owner', {
        merchantId: scope.merchantId,
        kind: 'preview.reply',
      }),
    ).toBeNull();
    expect(openConnection).not.toHaveBeenCalled();
  });
  it('decodes only typed versioned payloads with the actual raw input hash', () => {
    const p = {
      schemaVersion: 1,
      handlerVersion: 'draft-expand-v1',
      kind: 'draft.expand',
      merchantId: scope.merchantId,
      assistantId: scope.assistantId,
      requesterUserId: scope.userId,
      inputRevision: 1,
      requestHash: 'f'.repeat(64),
      input,
      inputFieldHash: knowledgeHash(input.currentText),
    };
    expect(decodeAuthoringPayload(p).kind).toBe('draft.expand');
    for (const patch of [
      { schemaVersion: 0 },
      { handlerVersion: 'knowledge-organize-v1' },
      { kind: 'preview.reply' },
      { inputFieldHash: knowledgeHash(input.currentText.trim()) },
      { inputRevision: 2 },
    ])
      expect(() => decodeAuthoringPayload({ ...p, ...patch })).toThrow();
  });
});
