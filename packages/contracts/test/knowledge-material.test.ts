import { describe, expect, it } from 'vitest';
import { parseMaterialOrganization } from '../src/knowledge-material.js';
describe('knowledge organization contract', () => {
  it('preserves the full maximum summary rather than silently truncating', () => {
    const summary = '资'.repeat(4000);
    expect(parseMaterialOrganization({ summary, warnings: [] })).toEqual({ summary, warnings: [] });
    expect(parseMaterialOrganization({ summary: `${summary}料`, warnings: [] })).toBeNull();
  });
  it.each([
    null,
    [],
    {},
    { summary: ' ', warnings: [] },
    { summary: '资料\u0000', warnings: [] },
    { summary: '资料', warnings: 'bad' },
    { summary: '资料', warnings: Array(11).fill('待确认') },
    { summary: '资料', warnings: ['字'.repeat(201)] },
  ])('rejects malformed or out-of-bounds generated values', (value) => {
    expect(parseMaterialOrganization(value)).toBeNull();
  });
});
