import { describe, it, expect } from 'vitest';
import { usagePage, usageActiveMs } from './usage-tracker';
describe('safe usage dimensions and time', () => {
  it('does not retain merchant IDs, assistant IDs or query data as page keys', () => {
    expect(usagePage('/' + 'a'.repeat(32) + '/drafts/' + 'b'.repeat(32))).toBe('drafts');
    expect(usagePage('/a/a-test')).toBe('consumer');
  });
  it('excludes background and idle time and bounds tail segments', () => {
    expect(usageActiveMs(false, 0, 15000)).toBe(0);
    expect(usageActiveMs(true, 60001, 15000)).toBe(0);
    expect(usageActiveMs(true, 0, 300000)).toBe(15000);
    expect(usageActiveMs(true, 0, 800)).toBe(800);
  });
});
