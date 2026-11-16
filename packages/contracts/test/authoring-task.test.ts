import { describe, it, expect } from 'vitest';
import {
  draftExpandRequestSchema,
  previewReplyRequestSchema,
  authoringTaskRetrySchema,
} from '../src/authoring-task.js';
const draft = {
  requestId: 'authoring_' + 'a'.repeat(32),
  revision: 7,
  field: 'pricingSummary',
  brief: '整理原文',
  currentText: ' 毛巾29元，运费需确认。 ',
  consent: true,
};
describe('authoring request boundaries', () => {
  it('retains raw field bytes for server hashing while sharing writing bounds', () => {
    expect(draftExpandRequestSchema.parse(draft).currentText).toBe(draft.currentText);
    for (const patch of [
      { merchantId: 'b'.repeat(32) },
      { field: 'privatePassword' },
      { consent: false },
      { brief: 'x'.repeat(1001) },
      { currentText: 'x'.repeat(4001) },
      { currentText: 'bad\u0000' },
      { revision: 0 },
    ])
      expect(draftExpandRequestSchema.safeParse({ ...draft, ...patch }).success).toBe(false);
  });
  it('preview accepts only a revision/question and never browser-supplied facts', () => {
    const input = { requestId: draft.requestId, revision: 7, question: '  运费多少？  ' };
    expect(previewReplyRequestSchema.parse(input).question).toBe('运费多少？');
    for (const patch of [
      { facts: { price: 1 } },
      { assistantId: 'b'.repeat(32) },
      { question: 'x'.repeat(2001) },
      { question: '' },
    ])
      expect(previewReplyRequestSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it('rejects old keys and forced retry authority', () => {
    expect(
      authoringTaskRetrySchema.safeParse({ requestId: 'organize_' + 'a'.repeat(32) }).success,
    ).toBe(false);
    expect(
      authoringTaskRetrySchema.safeParse({ requestId: draft.requestId, force: true }).success,
    ).toBe(false);
  });
});
