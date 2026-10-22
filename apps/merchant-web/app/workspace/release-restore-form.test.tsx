import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestoreReleaseState } from './release-history-actions';
const mocks = vi.hoisted(() => ({
  state: undefined as RestoreReleaseState | undefined,
  pending: false,
}));
vi.mock('react', async (importActual) => ({
  ...(await importActual<typeof import('react')>()),
  useActionState: (_action: unknown, initial: unknown) => [
    mocks.state ?? initial,
    () => undefined,
    mocks.pending,
  ],
}));
vi.mock('./release-history-actions', () => ({ restoreReleaseToDraftAction: vi.fn() }));
import { ReleaseRestoreForm } from './release-restore-form';
const props = {
  merchantId: 'aa'.repeat(16),
  assistantId: 'bb'.repeat(16),
  releaseId: 'cc'.repeat(16),
  releaseNo: 1,
  draftRevision: 4,
  csrfToken: 'owned-csrf',
};
describe('restore release confirmation and recovery guidance', () => {
  beforeEach(() => {
    mocks.state = undefined;
    mocks.pending = false;
    vi.stubGlobal('React', React);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('requires explicit consent with the source and optimistic-lock revision, not a publication checkbox', () => {
    const html = renderToStaticMarkup(<ReleaseRestoreForm {...props} />);
    expect(html.match(/type="checkbox"/gu)).toHaveLength(1);
    for (const name of [
      'merchantId',
      'assistantId',
      'releaseId',
      'draftRevision',
      'csrfToken',
      'restoreConfirmed',
    ])
      expect(html).toContain(`name="${name}"`);
    expect(html).toContain('恢复为待核对草稿');
    expect(html).toContain('当前消费者版本不会立即改变');
    expect(html).not.toContain('name="confirmAndPublish"');
    expect(html).not.toContain('disabled=""');
  });
  it('disables repeat submissions while pending and after success, without claiming a published version', () => {
    mocks.pending = true;
    expect(renderToStaticMarkup(<ReleaseRestoreForm {...props} />)).toContain('disabled=""');
    mocks.pending = false;
    mocks.state = { error: null, restored: { draftRevision: 5, sourceReleaseNo: 1 } };
    const html = renderToStaticMarkup(<ReleaseRestoreForm {...props} />);
    expect(html).toContain('草稿修订 5');
    expect(html).toContain('当前消费者版本未改变');
    expect(html).toContain(`/${props.merchantId}/drafts/${props.assistantId}`);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('href="/a/');
  });
  it('explains missing CSRF and preserves an unknown-error message for manual verification', () => {
    expect(renderToStaticMarkup(<ReleaseRestoreForm {...props} csrfToken="" />)).toContain(
      '重新登录',
    );
    mocks.state = { restored: null, error: '请刷新核对，不要盲目重复提交。' };
    expect(renderToStaticMarkup(<ReleaseRestoreForm {...props} />)).toContain('不要盲目重复提交');
  });
});
