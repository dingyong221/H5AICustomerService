import { describe, expect, it } from 'vitest';

import {
  decodeAssistantDraftSnapshot,
  decodeReleaseAcceptedResult,
  decodeReleaseOperation,
} from './assistant-management-contract';
import { snapshotFixture } from './assistant-management-test-fixture';

describe('assistant management response decoders', () => {
  it('decodes a complete bounded draft snapshot', () => {
    expect(decodeAssistantDraftSnapshot(snapshotFixture)).toEqual(snapshotFixture);
  });

  it('rejects unknown fields, weak revisions, and contradictory publish checks', () => {
    expect(
      decodeAssistantDraftSnapshot({ ...snapshotFixture, merchantId: 'must-not-leak' }),
    ).toBeUndefined();
    expect(
      decodeAssistantDraftSnapshot({
        ...snapshotFixture,
        etag: 'W/"draft-3"',
      }),
    ).toBeUndefined();
    expect(
      decodeAssistantDraftSnapshot({
        ...snapshotFixture,
        publishCheck: {
          items: [{ code: 'knowledge_required', level: 'blocked', message: '缺少知识' }],
          state: 'ready',
        },
      }),
    ).toBeUndefined();
  });

  it('requires succeeded operations to carry a complete result and failed operations a failure', () => {
    expect(
      decodeReleaseOperation({
        operationId: 'operation_01',
        result: {
          publicUrl: '/a/xiaolan-service',
          releaseId: 'release_01',
          releaseNo: 2,
        },
        state: 'succeeded',
      }),
    ).toMatchObject({ state: 'succeeded' });
    expect(
      decodeReleaseOperation({ operationId: 'operation_01', state: 'succeeded' }),
    ).toBeUndefined();
    expect(
      decodeReleaseOperation({ operationId: 'operation_01', state: 'failed' }),
    ).toBeUndefined();
  });

  it('strictly decodes the 202 release acceptance shape', () => {
    expect(
      decodeReleaseAcceptedResult({
        operationId: 'operation_01',
        pollUrl: '/api/v1/merchant/operations/operation_01',
        releaseId: 'release_01',
        state: 'accepted',
      }),
    ).toMatchObject({ operationId: 'operation_01', state: 'accepted' });
    expect(
      decodeReleaseAcceptedResult({
        operationId: 'operation_01',
        pollUrl: '/api/v1/merchant/operations/operation_01',
        releaseId: 'release_01',
        state: 'accepted',
        publicUrl: '/a/must-not-exist-yet',
      }),
    ).toBeUndefined();
  });
});
