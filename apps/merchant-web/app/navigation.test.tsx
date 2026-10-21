import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  pathname: '',
  params: {} as { merchantId?: string; assistantId?: string },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', props, children),
}));

import { MerchantNavigation } from './navigation';

const merchantId = 'aa'.repeat(16);
const assistantId = 'bb'.repeat(16);

describe('merchant navigation hierarchy', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
    navigation.params = { merchantId, assistantId };
    navigation.pathname = `/${merchantId}/knowledge/${assistantId}`;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('groups the selected assistant steps into an expandable active catalog', () => {
    const html = renderToStaticMarkup(<MerchantNavigation merchantId={merchantId} />);
    expect(html.match(/class="merchant-nav__group"/gu)).toHaveLength(3);
    expect(html).toContain('AI 客服');
    expect(html).toContain('日常运营');
    expect(html).toContain('支持工具');
    expect(html).toContain('客服列表');
    expect(html).toContain(`href="/${merchantId}/drafts/new"`);
    expect(html).toContain(`href="/${merchantId}/preview/${assistantId}"`);
    expect(html).toMatch(/aria-label="知识补充" aria-current="page"/u);
    expect(html.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(html).toMatch(/<details class="merchant-nav__group" open="">/u);
  });

  it('does not invent a selected assistant when browsing the list', () => {
    navigation.params = { merchantId };
    navigation.pathname = `/${merchantId}/drafts`;
    const html = renderToStaticMarkup(<MerchantNavigation merchantId={merchantId} />);
    expect(html).toMatch(/aria-label="客服列表" aria-current="page"/u);
    expect(html).not.toContain('基础资料');
    expect(html).not.toContain('知识补充');
    expect(html).not.toContain('效果试聊');
    expect(html).not.toContain('发布分享');
  });

  it('auto-opens the operations group and highlights a nested improvement page', () => {
    navigation.params = { merchantId };
    navigation.pathname = `/${merchantId}/improvements/${assistantId}`;
    const html = renderToStaticMarkup(
      <MerchantNavigation merchantId={merchantId} improvementCount={4} />,
    );
    expect(html).toContain('aria-label="问题与改进，待推进 4 项" aria-current="page"');
    expect(html.match(/<details class="merchant-nav__group" open="">/gu)).toHaveLength(2);
  });

  it('never links to a different merchant because of untrusted route parameters', () => {
    navigation.params = { merchantId: 'cc'.repeat(16), assistantId };
    const html = renderToStaticMarkup(<MerchantNavigation merchantId={merchantId} />);
    expect(html).not.toContain(`href="/${merchantId}`);
    expect(html).not.toContain(`href="/${'cc'.repeat(16)}`);
    expect(html).not.toContain('基础资料');
    expect(html).toContain('href="/console/account/login"');
    expect(html).not.toContain('aria-current="page"');
  });

  it('provides a named, initially collapsed mobile catalog toggle', () => {
    const html = renderToStaticMarkup(<MerchantNavigation merchantId={merchantId} />);
    expect(html).toContain('aria-controls="merchant-navigation-tree"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('展开菜单');
    expect(html).toContain('id="merchant-navigation-tree"');
  });
});
