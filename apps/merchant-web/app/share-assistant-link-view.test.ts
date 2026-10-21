import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/image', () => ({ default: () => null }));
import { copyAssistantLink, ShareAssistantLink } from './share-assistant-link';
const origin = 'https://h5cs.1rying.com',
  href = origin + '/a/a-fixed';
describe('clear permanent consumer sharing', () => {
  beforeEach(() => vi.stubGlobal('React', React));
  afterEach(() => vi.unstubAllGlobals());
  it('renders the persisted address, explicit copy control and unchanged-address guidance', () => {
    const html = renderToStaticMarkup(
      React.createElement(ShareAssistantLink, { href, expectedOrigin: origin }),
    );
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('复制消费者链接');
    expect(html).toContain('发布新版不会更换此地址');
  });
  it('copies only the safe configured public URL', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    expect(await copyAssistantLink(href, origin, clipboard)).toBe('copied');
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(href);
  });
  it('does not claim copy success if clipboard is unavailable or permission is denied', async () => {
    expect(await copyAssistantLink(href, origin, undefined)).toBe('failed');
    expect(
      await copyAssistantLink(href, origin, {
        writeText: vi.fn().mockRejectedValue(new Error('denied')),
      }),
    ).toBe('failed');
  });
  it('never copies management, credential-bearing or other-origin links', async () => {
    const clipboard = { writeText: vi.fn() };
    for (const invalid of [
      origin + '/console',
      href + '?token=no',
      href + '#no',
      'https://other.test/a/a-fixed',
    ])
      expect(await copyAssistantLink(invalid, origin, clipboard)).toBe('failed');
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});
