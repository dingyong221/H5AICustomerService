import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ saved: false, pending: false, refresh: vi.fn() }));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useActionState: (_action: unknown, initial: unknown) => [
    { ...(initial as object), saved: mocks.saved },
    () => {},
    mocks.pending,
  ],
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('./use-unsaved-form', () => ({ useUnsavedForm: () => () => {} }));
vi.mock('./governance-actions', () => ({
  renameAssistantAction: vi.fn(),
  judgePreviewCheckAction: vi.fn(),
  emergencyWithdrawAction: vi.fn(),
}));
import {
  EmergencyWithdrawForm,
  PreviewVerdictForm,
  RenameAssistantForm,
} from './governance-controls';
const scope = {
  merchantId: 'a'.repeat(32),
  assistantId: 'b'.repeat(32),
  draftRevision: 5,
  csrfToken: 'synthetic',
};
describe('merchant governance intent controls', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
    mocks.saved = false;
    mocks.pending = false;
  });
  afterEach(() => vi.unstubAllGlobals());
  it('explains rename and retains the exact scope and revision without replacing the customer link', () => {
    const html = renderToStaticMarkup(<RenameAssistantForm {...scope} displayName="原客服" />);
    for (const name of ['merchantId', 'assistantId', 'draftRevision', 'csrfToken', 'displayName'])
      expect(html).toContain(`name="${name}"`);
    expect(html).toContain('固定消费者链接不变');
    expect(html).toContain('重新试聊');
  });
  it('requires an explicit review confirmation and offers pass/fail rather than treating a model response as automatically qualified', () => {
    const html = renderToStaticMarkup(<PreviewVerdictForm {...scope} checkId={'c'.repeat(32)} />);
    expect(html).toContain('name="reviewConfirmed"');
    expect(html).toContain('name="checkId"');
    expect(html).toContain('value="pass"');
    expect(html).toContain('value="fail"');
    expect(html).toContain('不代表所有问题均已解决');
    expect(html.match(/data-usage="preview.pass"/gu)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*data-usage="preview.pass"[^>]*value="pass"/u);
    expect(html).not.toMatch(/<form[^>]*data-usage="preview.pass"/u);
  });
  it('explains withdrawal impacts and requires a reason, release CAS and one explicit consent', () => {
    const html = renderToStaticMarkup(
      <EmergencyWithdrawForm {...scope} expectedReleaseId={'d'.repeat(32)} />,
    );
    expect(html).toContain('name="reason"');
    expect(html).toContain('minLength="5"');
    expect(html).toContain('name="expectedReleaseId"');
    expect(html).toContain('name="withdrawalConfirmed"');
    expect(html).toContain('终结已有会话及未完成回复');
    expect(html).toContain('固定链接不变');
    expect(html).toContain('普通更新请使用正常发布');
  });
  it('locks a confirmed verdict against accidental duplicate submission until the refreshed status arrives', () => {
    mocks.saved = true;
    const html = renderToStaticMarkup(<PreviewVerdictForm {...scope} checkId={'c'.repeat(32)} />);
    expect(html.match(/disabled=""/gu)).toHaveLength(3);
  });
});
