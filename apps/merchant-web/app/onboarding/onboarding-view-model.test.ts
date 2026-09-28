import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildOnboardingViewModel,
  buildWorkBuddyEntryViewModel,
  buildWorkBuddyIdentityViewModel,
} from './onboarding-view-model';

afterEach(() => vi.unstubAllEnvs());

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

  it('shows a generated draft link only through the local login gate', () => {
    const result = {
      action: 'continue_onboarding' as const,
      missing_items: [],
      onboarding_session_id: '33333333333333333333333333333333',
      state: 'manageable' as const,
      management_url:
        'https://h5cs.1rying.com/workspace/22222222222222222222222222222222/assistants/44444444444444444444444444444444',
    };
    const own = buildOnboardingViewModel({
      applicationOrigin: 'https://h5cs.1rying.com',
      apiConnected: true,
      authorization: 'authorized',
      result,
    });
    expect(own.managementUrl).toContain('/account/login?merchant=22222222222222222222222222222222');
    const foreign = buildOnboardingViewModel({
      applicationOrigin: 'https://different.example.test',
      apiConnected: true,
      authorization: 'authorized',
      result,
    });
    expect(foreign.managementUrl).toBeUndefined();
  });

  it('gates a console-prefixed generated link without leaking the prefix into the return path', () => {
    vi.stubEnv('NEXT_PUBLIC_MERCHANT_BASE_PATH', '/console');
    const result = {
      action: 'continue_onboarding' as const,
      missing_items: [],
      onboarding_session_id: '33333333333333333333333333333333',
      state: 'manageable' as const,
      management_url:
        'https://h5cs.1rying.com/console/workspace/22222222222222222222222222222222/assistants/44444444444444444444444444444444',
    };
    const model = buildOnboardingViewModel({
      applicationOrigin: 'https://h5cs.1rying.com',
      apiConnected: true,
      authorization: 'authorized',
      result,
    });
    expect(model.managementUrl).toBe(
      '/account/login?merchant=22222222222222222222222222222222&next=%2Fworkspace%2F22222222222222222222222222222222%2Fassistants%2F44444444444444444444444444444444',
    );
    expect(
      buildOnboardingViewModel({
        applicationOrigin: 'https://h5cs.1rying.com',
        apiConnected: true,
        authorization: 'authorized',
        result: {
          ...result,
          management_url: result.management_url.replace('/console/', '/'),
        },
      }).managementUrl,
    ).toBeUndefined();
  });

  it('always gates management URLs behind login and rejects foreign origins', () => {
    const sameOrigin = buildWorkBuddyEntryViewModel({
      applicationOrigin: 'https://h5cs.1rying.com',
      authorization: 'authorized',
      result: {
        action: 'open_management_console',
        assistant: {
          assistant_ref: '44444444444444444444444444444444',
          display_name: '客服一',
          status: 'published',
        },
        url: 'https://h5cs.1rying.com/workspace/22222222222222222222222222222222/assistants/44444444444444444444444444444444',
      },
    });
    const foreignOrigin = buildWorkBuddyEntryViewModel({
      applicationOrigin: 'https://h5cs.1rying.com',
      authorization: 'authorized',
      result: {
        action: 'open_management_console',
        assistant: {
          assistant_ref: 'assistant-foreign',
          display_name: '外部客服',
          status: 'draft',
        },
        url: 'https://example.invalid/secret-entry',
      },
    });

    expect(sameOrigin.manage.requiresLogin).toBe(true);
    expect(sameOrigin.manage.href).toBe(
      '/account/login?merchant=22222222222222222222222222222222&next=%2Fworkspace%2F22222222222222222222222222222222%2Fassistants%2F44444444444444444444444444444444',
    );
    expect(foreignOrigin.manage.href).toBe('/account/login');
  });

  it('uses the exact authorized identity label', () => {
    expect(buildWorkBuddyIdentityViewModel('authorized').label).toBe('WorkBuddy已授权');
  });
});
