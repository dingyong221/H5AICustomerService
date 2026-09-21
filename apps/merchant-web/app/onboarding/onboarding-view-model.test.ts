import { describe, expect, it } from 'vitest';

import {
  buildOnboardingViewModel,
  buildWorkBuddyEntryViewModel,
  buildWorkBuddyIdentityViewModel,
} from './onboarding-view-model';

describe('WorkBuddy view models', () => {
  it('keeps a disconnected, unbound onboarding session read-only', () => {
    const viewModel = buildOnboardingViewModel({
      apiConnected: false,
      authorization: 'binding_required',
    });

    expect(viewModel.identity.label).toBe('需要安全绑定');
    expect(viewModel.canSubmit).toBe(false);
    expect(viewModel.isReadOnly).toBe(true);
    expect(viewModel.missingItemsLabel).toBe('尚未从服务端读取缺失项');
    expect(viewModel.steps.map((step) => step.status)).toEqual([
      'blocked',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
  });

  it('maps contract progress and missing items without advancing the state locally', () => {
    const viewModel = buildOnboardingViewModel({
      apiConnected: true,
      authorization: 'authorized',
      result: {
        action: 'continue_onboarding',
        missing_items: [
          { code: 'pricing_policy', message: '请确认价格信息如何处理。' },
          { code: 'promotion_policy', message: '请确认优惠信息如何处理。' },
        ],
        onboarding_session_id: 'onboarding-1',
        state: 'policy',
      },
    });

    expect(viewModel.state).toBe('policy');
    expect(viewModel.steps.map((step) => step.status)).toEqual([
      'complete',
      'complete',
      'current',
      'upcoming',
    ]);
    expect(viewModel.missingItems.map((item) => item.stepId)).toEqual(['policy', 'policy']);
    expect(viewModel.canCancel).toBe(true);
    expect(viewModel.canSubmit).toBe(false);
  });

  it('only enables generation for an authorized, connected and complete confirmation', () => {
    const viewModel = buildOnboardingViewModel({
      apiConnected: true,
      authorization: 'authorized',
      result: {
        action: 'continue_onboarding',
        missing_items: [],
        onboarding_session_id: 'onboarding-2',
        state: 'confirmation',
      },
    });

    expect(viewModel.canSubmit).toBe(true);
    expect(viewModel.primaryActionLabel).toBe('确认并开始生成');
  });

  it('exposes resume only for the cancelled contract state', () => {
    const viewModel = buildOnboardingViewModel({
      apiConnected: true,
      authorization: 'authorized',
      result: {
        action: 'continue_onboarding',
        missing_items: [],
        onboarding_session_id: 'onboarding-3',
        state: 'cancelled',
      },
    });

    expect(viewModel.canResume).toBe(true);
    expect(viewModel.canCancel).toBe(false);
  });

  it('always gates management URLs behind login and rejects foreign origins', () => {
    const sameOrigin = buildWorkBuddyEntryViewModel({
      applicationOrigin: 'https://h5cs.1rying.com',
      authorization: 'authorized',
      result: {
        action: 'open_management_console',
        assistant: {
          assistant_ref: 'assistant-1',
          status: 'published',
        },
        url: 'https://h5cs.1rying.com/assistants/assistant-1?tab=knowledge',
      },
    });
    const foreignOrigin = buildWorkBuddyEntryViewModel({
      applicationOrigin: 'https://h5cs.1rying.com',
      authorization: 'authorized',
      result: {
        action: 'open_management_console',
        assistant: {
          assistant_ref: 'assistant-foreign',
          status: 'draft',
        },
        url: 'https://example.invalid/secret-entry',
      },
    });

    expect(sameOrigin.manage.requiresLogin).toBe(true);
    expect(sameOrigin.manage.href).toBe(
      '/login?next=%2Fassistants%2Fassistant-1%3Ftab%3Dknowledge',
    );
    expect(foreignOrigin.manage.href).toBe('/login?next=%2F');
  });

  it('uses the exact authorized identity label', () => {
    expect(buildWorkBuddyIdentityViewModel('authorized').label).toBe('WorkBuddy已授权');
  });
});
