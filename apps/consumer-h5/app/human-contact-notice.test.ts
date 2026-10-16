import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HumanContactNotice } from './human-contact-notice';

describe('published human contact UI', () => {
  it('makes absent contact and the lack of real-time transfer explicit', () => {
    const html = renderToStaticMarkup(
      createElement(HumanContactNotice, { instructions: undefined }),
    );
    expect(html).toContain('尚未提供人工联系说明');
    expect(html).toContain('此处不实时转接');
    expect(html).toContain('不会自动通知人工');
    expect(html).not.toContain('已转接');
  });

  it('renders merchant contact as escaped plain text without turning it into arbitrary links', () => {
    const html = renderToStaticMarkup(
      createElement(HumanContactNotice, {
        instructions: '微信 shop_service\nhttps://shop.example/contact <script>alert(1)</script>',
      }),
    );
    expect(html).toContain('shop_service');
    expect(html).toContain('https://shop.example/contact');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a ');
  });
});
