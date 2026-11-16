import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewChatState } from './preview-chat-action';
const mocks = vi.hoisted(() => ({
  state: { answer: null, error: null, revision: null } as PreviewChatState,
}));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useActionState: () => [mocks.state, () => {}, false],
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('./preview-chat-action', () => ({ previewChatAction: vi.fn() }));
vi.mock('./governance-controls', () => ({
  PreviewVerdictForm: ({ checkId }: { checkId: string }) => <form data-review-id={checkId} />,
}));
import { PreviewChatForm } from './preview-chat-form';
const props = {
  merchantId: 'a'.repeat(32),
  assistantId: 'b'.repeat(32),
  draftRevision: 3,
  csrfToken: 'synthetic',
  available: true,
};
describe('synchronous preview receipt presentation', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
    mocks.state = { answer: null, error: null, revision: null };
  });
  afterEach(() => vi.unstubAllGlobals());
  it('shows a late conflicting answer as read-only, with no verdict or substituted receipt', () => {
    mocks.state = {
      answer: '迟到的回答',
      revision: 3,
      checkId: null,
      error: '这次迟到回答仅供查看，不能用于发布判定。',
    };
    const html = renderToStaticMarkup(
      <PreviewChatForm
        {...props}
        lastCheck={{
          state: 'needs_review',
          checkId: 'd'.repeat(32),
          question: '新的异步问题',
          answer: '新的异步回答',
          testedAt: '2026-11-17T00:00:00Z',
        }}
      />,
    );
    expect(html).toContain('迟到的回答');
    expect(html).toContain('不能用于发布判定');
    expect(html).not.toContain('data-review-id');
    expect(html).not.toContain('新的异步问题');
    expect(html).toContain('data-usage="preview.send"');
  });
  it('only exposes the exact trusted review receipt for a successful current revision', () => {
    mocks.state = { answer: '已保存回答', revision: 3, checkId: 'c'.repeat(32), error: null };
    expect(renderToStaticMarkup(<PreviewChatForm {...props} />)).toContain(
      `data-review-id="${'c'.repeat(32)}"`,
    );
  });
  it('hides old revision answers and cannot judge an old receipt', () => {
    mocks.state = { answer: '旧稿回答', revision: 2, checkId: 'c'.repeat(32), error: null };
    const html = renderToStaticMarkup(<PreviewChatForm {...props} />);
    expect(html).not.toContain('旧稿回答');
    expect(html).not.toContain('data-review-id');
  });
});
