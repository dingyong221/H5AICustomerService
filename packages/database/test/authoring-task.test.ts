import { describe, it, expect, vi } from 'vitest';
import { MySqlAuthoringTaskRepository } from '../src/authoring-task-repository.js';
import { authorizeAuthoringScope, decodeAuthoringPayload } from '../src/authoring-task-contract.js';
import { parseAssistantDraft } from '../src/assistant-lifecycle-repository.js';
import { governanceFactsHash } from '../src/publication-governance.js';
import type { Connection } from 'mysql2/promise';
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
  const draft = {
    industry: '合成零售',
    businessScope: '合成商品',
    materialsSummary: '毛巾29元',
    pricingSummary: '毛巾29元，运费待确认',
    promotionSummary: '无优惠',
    welcomeMessage: '您好',
    insufficientInfoMessage: '请联系商家',
    humanContact: '合成人工',
  };
  const connection = (config: unknown) =>
    ({
      execute: vi.fn(async (sql: string) => [
        sql.startsWith('SELECT d.revision')
          ? [{ revision: 1 }]
          : [{ display_name: '合成客服', config }],
      ]),
    }) as unknown as Connection;
  it('uses the same facts hash as publication for reordered MySQL JSON keys', async () => {
    const reordered = Object.fromEntries(Object.entries(draft).reverse()) as typeof draft;
    const actual = await authorizeAuthoringScope(connection(reordered), scope);
    expect(actual.factsHash).toBe(
      governanceFactsHash('合成客服', parseAssistantDraft(draft)).toString('hex'),
    );
    expect(actual.draft).toEqual(parseAssistantDraft(draft));
    expect(actual.factsHash).not.toBe(governanceFactsHash('合成客服', reordered).toString('hex'));
  });
  it('keeps the legacy empty contact normalization and detects changed business facts', async () => {
    const empty = { ...draft, humanContact: '' };
    const actual = await authorizeAuthoringScope(connection(empty), scope);
    expect(actual.factsHash).toBe(
      governanceFactsHash('合成客服', parseAssistantDraft(empty)).toString('hex'),
    );
    expect(actual.draft).not.toHaveProperty('humanContact');
    const changed = await authorizeAuthoringScope(
      connection({ ...empty, pricingSummary: '毛巾39元' }),
      scope,
    );
    expect(changed.factsHash).not.toBe(actual.factsHash);
  });
  it('fails closed for malformed stored business facts rather than hashing an unchecked object', async () => {
    await expect(
      authorizeAuthoringScope(connection({ ...draft, pricingSummary: null }), scope),
    ).rejects.toThrow();
  });
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
