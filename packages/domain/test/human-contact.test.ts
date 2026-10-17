import { describe, expect, it } from 'vitest';

import { normalizeHumanContact } from '../src/assistant-lifecycle-repository.js';

describe('published human contact instructions', () => {
  it('normalizes legacy absence, optional emptiness and multiline merchant instructions', () => {
    expect(normalizeHumanContact(undefined)).toBe('');
    expect(normalizeHumanContact('  ')).toBe('');
    expect(normalizeHumanContact(' 工作日 9:00—18:00\r\n微信：shop_service ')).toBe(
      '工作日 9:00—18:00\n微信：shop_service',
    );
    expect(normalizeHumanContact('https://shop.example/contact')).toBe(
      'https://shop.example/contact',
    );
    expect(normalizeHumanContact('联'.repeat(500))).toHaveLength(500);
  });

  it.each([
    null,
    123,
    {},
    '<script>alert(1)</script>',
    '<a href="https://example.com">联系</a>',
    '电话\u0000隐藏',
    '联'.repeat(501),
  ])('rejects invalid contact data %#', (value) => {
    expect(normalizeHumanContact(value)).toBeNull();
  });
});
