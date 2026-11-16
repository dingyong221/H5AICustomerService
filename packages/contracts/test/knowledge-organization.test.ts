import { describe, expect, it } from 'vitest';
import {
  knowledgeOrganizationRequestSchema,
  knowledgeOrganizationApplySchema,
  knowledgeOrganizationRetrySchema,
  knowledgeOrganizationCancelSchema,
} from '../src/knowledge-organization.js';
const input = {
  requestId: 'organize_' + 'a'.repeat(32),
  revision: 7,
  sourceIds: ['b'.repeat(32)],
  consent: true,
};
describe('persistent knowledge request contracts', () => {
  it('accepts bounded consented sources and rejects authority fields supplied by a browser', () => {
    expect(knowledgeOrganizationRequestSchema.parse(input)).toEqual(input);
    for (const value of [
      { ...input, merchantId: 'c'.repeat(32) },
      { ...input, consent: false },
      { ...input, sourceIds: [...input.sourceIds, ...input.sourceIds] },
      { ...input, revision: 0 },
      { ...input, sourceIds: Array.from({ length: 6 }, (_, i) => String(i).repeat(32)) },
      { ...input, requestId: 'old-key' },
    ])
      expect(knowledgeOrganizationRequestSchema.safeParse(value).success).toBe(false);
  });
  it('requires explicit revision/confirmation for adoption and distinct retry request identity', () => {
    expect(
      knowledgeOrganizationApplySchema.parse({
        revision: 7,
        summary: ' 毛巾29元，运费未知。 ',
        mode: 'append',
        confirmed: true,
      }).summary,
    ).toBe('毛巾29元，运费未知。');
    for (const value of [
      { revision: 7, summary: 'x', mode: 'append', confirmed: false },
      { revision: 8, summary: 'x', mode: 'publish', confirmed: true },
      { revision: 7, summary: 'x'.repeat(4001), mode: 'replace', confirmed: true },
    ])
      expect(knowledgeOrganizationApplySchema.safeParse(value).success).toBe(false);
    expect(
      knowledgeOrganizationRetrySchema.safeParse({ requestId: input.requestId, force: true })
        .success,
    ).toBe(false);
    expect(knowledgeOrganizationCancelSchema.safeParse({ scope: 'all' }).success).toBe(false);
  });
});
