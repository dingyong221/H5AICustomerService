import { describe, expect, it } from 'vitest';
import { normalizeOpsPath, opsMenuGroups, selectedOpsHref } from './ops-navigation-model';

describe('operator sidebar routing', () => {
  it.each([
    ['/', '/'],
    ['/ops', '/'],
    ['/ops/', '/'],
    ['/ops/merchants/abc', '/merchants/abc'],
    ['/merchants', '/merchants'],
    ['/opshop', '/opshop'],
  ])('normalizes %s without stripping unrelated prefixes', (raw, expected) => {
    expect(normalizeOpsPath(raw)).toBe(expected);
  });
  it.each(['/', '/ops', '/ops/'])('selects the overview at %s', (path) => {
    expect(selectedOpsHref(path, null, '')).toBe('/');
  });
  it.each(['/merchants', '/merchants/abc', '/ops/merchants/abc'])(
    'keeps merchant details in their parent group',
    (path) => {
      expect(selectedOpsHref(path, null, '')).toBe('/merchants');
    },
  );
  it.each(opsMenuGroups[1].items)('selects report $label by query, not just pathname', (item) => {
    const kind = new URL(item.href, 'https://example.invalid').searchParams.get('report');
    expect(selectedOpsHref('/ops/reports', kind, '')).toBe(item.href);
  });
  it.each([null, '', 'invalid'])('defaults missing or invalid report %s to daily', (kind) => {
    expect(selectedOpsHref('/reports', kind, '')).toBe('/reports?report=daily');
  });
  it('uses known homepage sections only on the homepage', () => {
    expect(selectedOpsHref('/ops', null, '#provision')).toBe('/#provision');
    expect(selectedOpsHref('/', null, '#audit-log')).toBe('/#audit-log');
    expect(selectedOpsHref('/', null, '#unknown')).toBe('/');
    expect(selectedOpsHref('/merchants', null, '#provision')).toBe('/merchants');
    expect(selectedOpsHref('/login', null, '')).toBeNull();
    expect(selectedOpsHref('/reports/export', null, '')).toBeNull();
  });
  it('has unique group IDs and destinations, preventing ambiguous controls and selection', () => {
    const ids = opsMenuGroups.map((group) => group.id);
    const hrefs = opsMenuGroups.flatMap((group) => group.items.map((item) => item.href));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
