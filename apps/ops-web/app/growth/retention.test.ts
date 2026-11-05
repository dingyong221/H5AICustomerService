import { describe, it, expect } from 'vitest';
import { retentionValue } from './retention';
describe('Beijing cohort maturity', () => {
  it('does not present partial target days as failed retention', () => {
    expect(retentionValue('2026-11-01', 10, 0, 7, new Date('2026-11-08T15:59:59Z'))).toBe('未成熟');
    expect(retentionValue('2026-11-01', 10, 3, 7, new Date('2026-11-08T16:00:00Z'))).toBe('30.0%');
  });
  it('keeps missing cohorts separate from zero', () => {
    expect(retentionValue('2026-11-01', 0, 0, 1)).toBe('无样本');
  });
});
