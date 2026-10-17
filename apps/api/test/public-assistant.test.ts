import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PublicAssistantSnapshot } from '@h5cs/domain';

import { PublicAssistantService } from '../src/public/public-assistant.service.js';

const snapshot: PublicAssistantSnapshot = {
  publicAssistantId: 'a-abcdefghijklmnop',
  releaseRef: '11'.repeat(16),
  merchantName: '示例商家',
  assistantName: '示例 AI 客服',
  businessScope: '介绍商家的产品和服务',
  welcomeMessage: '你好，我是 AI 客服。',
  insufficientInfoMessage: '资料不足时请联系商家。',
  availability: 'online',
};

describe('public assistant snapshot', () => {
  it('returns only public fields from a published release', async () => {
    const findPublicSnapshot = vi.fn(async () => snapshot);
    const service = new PublicAssistantService({ findPublicSnapshot });
    await expect(service.load(snapshot.publicAssistantId)).resolves.toEqual({
      publicAssistantId: snapshot.publicAssistantId,
      releaseRef: snapshot.releaseRef,
      merchantDisplayName: snapshot.merchantName,
      assistantDisplayName: snapshot.assistantName,
      aiDisclosure: true,
      businessScope: snapshot.businessScope,
      welcomeMessage: snapshot.welcomeMessage,
      humanContact: '',
      availability: 'online',
    });
    expect(findPublicSnapshot).toHaveBeenCalledWith(snapshot.publicAssistantId);
  });

  it('exposes only the contact instructions returned by the published snapshot reader', async () => {
    const service = new PublicAssistantService({
      findPublicSnapshot: async () => ({
        ...snapshot,
        humanContact: '微信 shop_service，工作日9—18点',
      }),
    });
    await expect(service.load(snapshot.publicAssistantId)).resolves.toMatchObject({
      humanContact: '微信 shop_service，工作日9—18点',
    });
  });

  it('does not expose invalid or unpublished assistant identifiers', async () => {
    const findPublicSnapshot = vi.fn(async () => null);
    const service = new PublicAssistantService({ findPublicSnapshot });
    await expect(service.load('../other')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    expect(findPublicSnapshot).not.toHaveBeenCalled();
    await expect(service.load('a-unknown')).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it('fails closed when MySQL or the repository is unavailable', async () => {
    await expect(
      PublicAssistantService.fromEnvironment({
        NODE_ENV: 'test',
        PUBLIC_CONVERSATION_ENABLED: 'false',
      }).load('a-valid'),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    await expect(new PublicAssistantService(null).load('a-valid')).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
    const service = new PublicAssistantService({
      findPublicSnapshot: async () => {
        throw new Error('database is down');
      },
    });
    await expect(service.load('a-valid')).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});
