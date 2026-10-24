import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ notice: null as string | null, copy: vi.fn() }));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useState: () => [
    mocks.notice,
    (notice: string | null) => {
      mocks.notice = notice;
    },
  ],
}));
import { HumanContactNotice } from './human-contact-notice';
type Props = { children?: ReactNode; onClick?: () => Promise<void> };
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : [];
}
const instructions = '工作日9—18点 微信 test_service';
const render = () => HumanContactNotice({ instructions });
describe('published contact copy actions', () => {
  beforeEach(() => {
    mocks.notice = null;
    vi.clearAllMocks();
    vi.stubGlobal('navigator', { clipboard: { writeText: mocks.copy } });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('copies only after an explicit click and confirms the published contact text', async () => {
    const tree = render();
    expect(mocks.copy).not.toHaveBeenCalled();
    await nodes(tree).find((node) => node.type === 'button')!.props.onClick!();
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(instructions);
    expect(mocks.notice).toContain('已复制联系说明');
  });
  it('offers manual copying when browser clipboard permission is unavailable', async () => {
    mocks.copy.mockRejectedValueOnce(new Error('permission denied'));
    await nodes(render()).find((node) => node.type === 'button')!.props.onClick!();
    expect(mocks.notice).toContain('长按或选中');
    expect(mocks.notice).not.toContain('permission');
  });
});
