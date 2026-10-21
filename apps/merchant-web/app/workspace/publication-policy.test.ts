import { describe, expect, it } from 'vitest';

import { publicationPolicy, publicAssistantUrl, publicSharingOrigin } from './publication-policy';

const readyEnvironment = {
  NODE_ENV: 'production',
  PUBLIC_CONVERSATION_ENABLED: 'true',
  CONSUMER_H5_ORIGIN: 'https://h5cs.1rying.com',
  MODEL_PROVIDER: 'chat_completions',
  MODEL_NAME: 'approved-model',
  CONVERSATION_WORKER_ENABLED: 'true',
  PUBLISH_PROMPT_TEMPLATE_VERSION: 'prompt-v1',
  PUBLISH_RETRIEVAL_POLICY_VERSION: 'merchant-facts-v1',
  PUBLISH_MODEL_POLICY_VERSION: 'approved-model-v1',
} satisfies NodeJS.ProcessEnv;

describe('merchant publication gate', () => {
  it('stays closed until the complete conversation runtime has been verified', () => {
    expect(
      publicationPolicy({ ...readyEnvironment, PUBLIC_CONVERSATION_ENABLED: 'false' }),
    ).toMatchObject({ ready: false });
    expect(publicationPolicy({ ...readyEnvironment, MODEL_PROVIDER: 'mock' })).toMatchObject({
      ready: false,
    });
    expect(
      publicationPolicy({ ...readyEnvironment, CONVERSATION_WORKER_ENABLED: 'false' }),
    ).toMatchObject({ ready: false });
    expect(
      publicationPolicy({ ...readyEnvironment, PUBLISH_MODEL_POLICY_VERSION: '' }),
    ).toMatchObject({ ready: false });
    expect(
      publicationPolicy({ ...readyEnvironment, CONSUMER_H5_ORIGIN: 'http://h5cs.1rying.com' }),
    ).toMatchObject({ ready: false });
  });

  it('returns exact policy versions and a fixed H5 URL only for a ready configuration', () => {
    expect(publicationPolicy(readyEnvironment)).toEqual({
      ready: true,
      consumerOrigin: 'https://h5cs.1rying.com',
      promptTemplateVersion: 'prompt-v1',
      retrievalPolicyVersion: 'merchant-facts-v1',
      modelPolicyVersion: 'approved-model-v1',
    });
    expect(publicAssistantUrl('https://h5cs.1rying.com', 'a-example')).toBe(
      'https://h5cs.1rying.com/a/a-example',
    );
    expect(publicAssistantUrl('https://h5cs.1rying.com', '../other')).toBeNull();
  });

  it('retains only the validated sharing origin when publication policy is temporarily closed', () => {
    for (const changed of [
      { PUBLIC_CONVERSATION_ENABLED: 'false' },
      { MODEL_PROVIDER: 'mock' },
      { CONVERSATION_WORKER_ENABLED: 'false' },
      { PUBLISH_MODEL_POLICY_VERSION: '' },
    ]) {
      const environment = { ...readyEnvironment, ...changed };
      expect(publicationPolicy(environment).ready).toBe(false);
      expect(publicSharingOrigin(environment)).toBe('https://h5cs.1rying.com');
    }
  });

  it('does not bypass origin security merely to display a persisted link', () => {
    for (const origin of [
      '',
      'http://h5cs.1rying.com',
      'https://user:password@h5cs.1rying.com',
      'https://h5cs.1rying.com/path',
      'https://h5cs.1rying.com?token=bad',
      'https://h5cs.1rying.com#fragment',
      'javascript:alert(1)',
    ])
      expect(publicSharingOrigin({ ...readyEnvironment, CONSUMER_H5_ORIGIN: origin })).toBeNull();
  });
});
