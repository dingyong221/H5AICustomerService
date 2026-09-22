import { describe, expect, it } from 'vitest';

import type { ReleaseOperation } from './assistant-management-contract';
import { snapshotFixture } from './assistant-management-test-fixture';
import {
  buildAssistantManagementViewModel,
  resolveSafePublicAssistantUrl,
  validateAssistantDraftUpdate,
} from './assistant-management-view-model';

const applicationOrigin = 'https://merchant.example.com';

describe('assistant management view model', () => {
  it('fails closed without a trusted snapshot', () => {
    expect(buildAssistantManagementViewModel({ applicationOrigin })).toMatchObject({
      canPublish: false,
      canSave: false,
      state: 'unavailable',
    });
    expect(
      buildAssistantManagementViewModel({ applicationOrigin, errorKind: 'not_found' }),
    ).toMatchObject({ state: 'not_found' });
  });

  it('shows checks and enables publish only for a ready server snapshot', () => {
    const model = buildAssistantManagementViewModel({
      applicationOrigin,
      snapshot: snapshotFixture,
    });
    expect(model).toMatchObject({
      canCheck: true,
      canPublish: true,
      canSave: true,
      state: 'ready',
    });
    expect(model.publicHref).toBeUndefined();
    expect(model.publishItems).toHaveLength(2);
  });

  it('never shows a public URL before the operation succeeds', () => {
    for (const operation of [
      { operationId: 'operation_01', state: 'accepted' },
      { operationId: 'operation_01', state: 'processing' },
      {
        failure: { code: 'operation_failed', message: '发布任务失败' },
        operationId: 'operation_01',
        state: 'failed',
      },
    ] satisfies ReleaseOperation[]) {
      expect(
        buildAssistantManagementViewModel({
          applicationOrigin,
          operation,
          snapshot: snapshotFixture,
        }).publicHref,
      ).toBeUndefined();
    }
  });

  it('pauses all writes when a loaded snapshot becomes conflicted or unconfirmed', () => {
    for (const errorKind of ['conflict', 'unavailable'] as const) {
      expect(
        buildAssistantManagementViewModel({
          applicationOrigin,
          errorKind,
          snapshot: snapshotFixture,
        }),
      ).toMatchObject({ canPublish: false, canSave: false });
    }
  });

  it('shows only a same-origin safe public URL from a succeeded operation', () => {
    const succeeded = (publicUrl: string): ReleaseOperation => ({
      operationId: 'operation_01',
      result: { publicUrl, releaseId: 'release_01', releaseNo: 1 },
      state: 'succeeded',
    });
    expect(
      buildAssistantManagementViewModel({
        applicationOrigin,
        operation: succeeded('/a/xiaolan-service'),
        snapshot: snapshotFixture,
      }),
    ).toMatchObject({
      publicHref: 'https://merchant.example.com/a/xiaolan-service',
      state: 'published',
    });
    for (const unsafe of [
      'https://evil.example/a/xiaolan-service',
      '/a/UPPERCASE',
      '/a/xiaolan-service?token=secret',
      '/a/xiaolan-service/more',
      '/other/xiaolan-service',
    ]) {
      expect(resolveSafePublicAssistantUrl(unsafe, applicationOrigin)).toBeUndefined();
    }
  });

  it('validates all editable draft fields before a write', () => {
    expect(
      validateAssistantDraftUpdate({
        assistantName: '小蓝客服',
        businessScope: '空调清洗服务咨询',
        insufficientInfoMessage: '资料不足，请联系商家确认。',
        welcomeMessage: '你好，我是小蓝 AI 客服。',
      }),
    ).toEqual({});
    expect(
      validateAssistantDraftUpdate({
        assistantName: ' ',
        businessScope: 'x'.repeat(501),
        insufficientInfoMessage: '资料不足',
        welcomeMessage: '你好',
      }),
    ).toMatchObject({ assistantName: expect.any(String), businessScope: expect.any(String) });
  });
});
