import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishAssistantState } from './publish-actions';

const mocks = vi.hoisted(() => ({
  state: undefined as PublishAssistantState | undefined,
  pending: false,
  refresh: vi.fn(),
  action: vi.fn(),
  effects: [] as (() => void)[],
}));
vi.mock('react', async (importActual) => ({
  ...(await importActual<typeof import('react')>()),
  useActionState: (_action: unknown, initial: unknown) => [
    mocks.state ?? initial,
    () => undefined,
    mocks.pending,
  ],
  useEffect: (effect: () => void) => mocks.effects.push(effect),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('./publish-actions', () => ({ confirmAndPublishAssistantAction: mocks.action }));
vi.mock('../share-assistant-link', () => ({
  ShareAssistantLink: ({ href }: { href: string }) =>
    React.createElement('a', { href }, '固定消费者链接'),
}));
import { PublishAssistantForm } from './publish-assistant-form';
const props = {
  merchantId: 'a'.repeat(32),
  assistantId: 'b'.repeat(32),
  draftRevision: 4,
  csrfToken: 'owned-csrf',
  idempotencyKey: '11111111-2222-4333-8444-555555555555',
  ready: true,
  reason: null,
  consumerOrigin: 'https://customer.test',
};
describe('single combined publication consent', () => {
  beforeEach(() => {
    mocks.state = undefined;
    mocks.pending = false;
    mocks.effects = [];
    mocks.refresh.mockClear();
    vi.stubGlobal('React', React);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('has exactly one explicit combined checkbox and one matching release button', () => {
    const html = renderToStaticMarkup(React.createElement(PublishAssistantForm, props));
    expect(html.match(/type="checkbox"/gu)).toHaveLength(1);
    expect(html).toContain('name="confirmAndPublish"');
    expect(html).not.toContain('name="publishConfirmed"');
    expect(html).toContain('我已核对以上资料，并确认向消费者公开发布当前修订。');
    expect(html).toContain('确认资料并发布 AI 客服');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('/a/');
  });
  it('retains all scoped security/revision/idempotency inputs', () => {
    const html = renderToStaticMarkup(React.createElement(PublishAssistantForm, props));
    for (const name of [
      'merchantId',
      'assistantId',
      'draftRevision',
      'csrfToken',
      'idempotencyKey',
    ])
      expect(html).toContain(`name="${name}"`);
  });
  it.each([{ ready: false, reason: '服务尚未就绪' }, { csrfToken: '' }])(
    'does not enable a publication missing runtime/security readiness',
    (changed) => {
      const html = renderToStaticMarkup(
        React.createElement(PublishAssistantForm, { ...props, ...changed }),
      );
      expect(html.match(/disabled=""/gu)).toHaveLength(2);
    },
  );
  it('shows a real successful link immediately, not a link for confirmation alone', () => {
    mocks.state = {
      error: null,
      published: true,
      publicUrl: 'https://customer.test/a/fixed',
      releaseNo: 1,
    };
    const html = renderToStaticMarkup(React.createElement(PublishAssistantForm, props));
    expect(html).toContain('第 1 版已发布');
    expect(html).toContain('href="https://customer.test/a/fixed"');
    expect(html.match(/disabled=""/gu)).toHaveLength(2);
  });
  it('does not duplicate the share card once the persisted link has refreshed above it', () => {
    mocks.state = {
      error: null,
      published: true,
      publicUrl: 'https://customer.test/a/fixed',
      releaseNo: 2,
    };
    const html = renderToStaticMarkup(
      React.createElement(PublishAssistantForm, { ...props, hasPublishedLink: true }),
    );
    expect(html).toContain('第 2 版已发布');
    expect(html).not.toContain('href="https://customer.test/a/fixed"');
  });
  it('refreshes once and reveals the persisted link once after successful publication', () => {
    const linkCard = { scrollIntoView: vi.fn(), focus: vi.fn() };
    const getElementById = vi.fn(() => linkCard);
    vi.stubGlobal('document', { getElementById });
    mocks.state = {
      error: null,
      published: true,
      publicUrl: 'https://customer.test/a/fixed',
      releaseNo: 2,
    };
    renderToStaticMarkup(
      React.createElement(PublishAssistantForm, { ...props, hasPublishedLink: true }),
    );
    for (let repeat = 0; repeat < 2; repeat++) for (const effect of mocks.effects) effect();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(getElementById).toHaveBeenCalledWith('consumer-link');
    expect(linkCard.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      behavior: 'smooth',
      block: 'start',
    });
    expect(linkCard.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
  it.each([
    { published: false, hasPublishedLink: true },
    { published: true, hasPublishedLink: false },
  ])('does not scroll before real publication and a persisted link card exist: %j', (condition) => {
    const getElementById = vi.fn();
    vi.stubGlobal('document', { getElementById });
    mocks.state = {
      error: null,
      published: condition.published,
      publicUrl: condition.published ? 'https://customer.test/a/fixed' : null,
      releaseNo: condition.published ? 1 : null,
    };
    renderToStaticMarkup(
      React.createElement(PublishAssistantForm, {
        ...props,
        hasPublishedLink: condition.hasPublishedLink,
      }),
    );
    for (const effect of mocks.effects) effect();
    expect(getElementById).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(condition.published ? 1 : 0);
  });
});
