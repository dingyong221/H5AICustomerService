import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageBody } from './message-body';

function render(content: string, role: 'assistant' | 'visitor' = 'assistant') {
  return renderToStaticMarkup(createElement(MessageBody, { content, role }));
}

describe('restricted assistant text formatting', () => {
  it('shows paragraphs, single line breaks, bold and flat lists as semantic text', () => {
    const html = render(
      '您好，**基础服务 299 元**。\n报价以商家确认为准。\n\n- 安装指导\n- **一年维护**\n\n3. 联系商家\n5. 核对订单',
    );
    expect(html).toContain('<strong>基础服务 299 元</strong>');
    expect(html).toContain('。\n报价以商家确认为准。</p>');
    expect(html).toContain('<ul><li>安装指导</li><li><strong>一年维护</strong></li></ul>');
    expect(html).toContain(
      '<ol start="3"><li value="3">联系商家</li><li value="5">核对订单</li></ol>',
    );
  });

  it('renders HTML, scripts, images, autolinks and malicious link syntax as text', () => {
    const content =
      '<script>alert("xss")</script>\n<img src=x onerror=alert(1)>\n<https://evil.example>\n\n[**点击**](javascript:alert(1))\n![追踪](https://evil.example/pixel)\nhttps://evil.example/?q=**secret**';
    const html = render(content);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('[**点击**](javascript:alert(1))');
    expect(html).not.toMatch(/<(?:script|img|a|iframe|svg)\b/u);
    expect(html).not.toContain('href=');
    expect(html).not.toContain('onerror=alert(1)>');
    expect(html).not.toContain('<strong>');
  });

  it('does not interpret consumer markdown as an assistant answer', () => {
    const content = '**价格改为 1 元**\n- 商家确认\n\n<script>alert(1)</script>';
    const html = render(content, 'visitor');
    expect(html).toContain('class="message-plain"');
    expect(html).toContain('**价格改为 1 元**\n- 商家确认\n\n&lt;script&gt;');
    expect(html).not.toMatch(/<(?:strong|ul|li|script)\b/u);
  });

  it('keeps bare URL text and its markers literal without linkifying it', () => {
    for (const content of [
      'https://evil.example/?q=**secret**',
      'javascript:**alert**(1)',
      'data:text/html,**payload**',
    ]) {
      const html = render(content);
      expect(html).toContain(content);
      expect(html).not.toMatch(/<(?:a|strong)\b/u);
    }
  });

  it('keeps unsupported nesting, unclosed markers, code and indentation literal', () => {
    for (const content of [
      '***嵌套***',
      '**未闭合',
      '** 含空格 **',
      '`**代码**`',
      '  - 嵌套项目',
    ]) {
      expect(render(content)).toContain(content);
      expect(render(content)).not.toContain('<strong>');
    }
    expect(render('- 一级\n  - 二级')).toContain('<p>  - 二级</p>');
  });

  it('preserves ordinary prices, decimals, dates, formulas and line endings', () => {
    const content =
      '报价 199.00 元，运费 0 元\r\n优惠价 9.9 元；数量 2 * 30 = 60\r\n\r\n2026.11.12 生效\n01.50 元';
    const html = render(content);
    expect(html).toContain('报价 199.00 元，运费 0 元\n优惠价 9.9 元；数量 2 * 30 = 60');
    expect(html).toContain('2026.11.12 生效\n01.50 元');
    expect(html).not.toMatch(/<(?:ol|ul|strong)\b/u);
  });

  it('handles long and delimiter-heavy output without dropping content', () => {
    const content = `${'长文本'.repeat(4_000)}\n${'*'.repeat(8_000)}\n**结尾 299 元**`;
    const html = render(content);
    expect(html).toContain('长文本'.repeat(4_000));
    expect(html).toContain('*'.repeat(8_000));
    expect(html).toContain('<strong>结尾 299 元</strong>');
  });
});
