import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { ApiEnvelopeInterceptor } from '../src/api-envelope.interceptor.js';
import { PublicAssistantController } from '../src/public/public-assistant.controller.js';
import { PublicAssistantService } from '../src/public/public-assistant.service.js';
import { publicSnapshotForClient } from '../src/public/public-client-features.js';
import { PublicSessionService } from '../src/public/public-session.service.js';
import { PublicTurnController } from '../src/public/public-turn.controller.js';
import { PublicTurnService } from '../src/public/public-turn.service.js';

const published = {
  publicAssistantId: 'a-retail-help',
  releaseRef: '11'.repeat(16),
  merchantName: '测试商家',
  assistantName: '测试客服',
  businessScope: '保温杯零售',
  welcomeMessage: '你好，我是AI客服。',
  insufficientInfoMessage: '需要商家确认',
  humanContact: '微信 shop_service，工作日9—18点',
  availability: 'online' as const,
};

describe('public additive snapshot negotiation', () => {
  it('preserves exact legacy fields unless an exact known feature token was requested', () => {
    const input = {
      publicAssistantId: published.publicAssistantId,
      humanContact: published.humanContact,
    };
    for (const feature of [undefined, '', 'other', 'not-human-contact', 'human-contact-extra']) {
      expect(publicSnapshotForClient(input, feature)).toEqual({
        publicAssistantId: published.publicAssistantId,
      });
    }
    expect(publicSnapshotForClient(input, 'other, human-contact')).toEqual(input);
    expect(input.humanContact).toBe(published.humanContact);
  });

  it('negotiates snapshots and pinned histories over the actual HTTP routes, leaving old clients unchanged', async () => {
    const assistantService = new PublicAssistantService({
      findPublicSnapshot: async () => published,
    });
    const snapshot = await assistantService.load(published.publicAssistantId);
    const handle = `s_${'22'.repeat(16)}`;
    const history = {
      sessionHandle: handle,
      releaseRef: snapshot.releaseRef,
      createdAt: '2026-10-17T00:00:00.000Z',
      snapshot,
      messages: [],
      activeTurn: null,
      hasEarlierMessages: false,
    };
    const sessionService = new PublicSessionService(
      { createSession: vi.fn(), readHistory: async () => history },
      true,
    );
    @Module({
      controllers: [PublicAssistantController, PublicTurnController],
      providers: [
        { provide: PublicAssistantService, useValue: assistantService },
        { provide: PublicSessionService, useValue: sessionService },
        { provide: PublicTurnService, useValue: {} },
      ],
    })
    class FeatureTestModule {}
    const app = await NestFactory.create(FeatureTestModule, { logger: false });
    app.useGlobalInterceptors(new ApiEnvelopeInterceptor());
    try {
      await app.listen(0, '127.0.0.1');
      for (const path of [
        `/api/v1/public/assistants/${published.publicAssistantId}`,
        `/api/v1/public/sessions/${handle}/history`,
      ]) {
        const isHistory = path.endsWith('/history');
        for (const enabled of [false, true]) {
          const response = await fetch(`${await app.getUrl()}${path}`, {
            headers: {
              Cookie: `__Host-h5cs_visitor=${'A'.repeat(43)}`,
              ...(enabled ? { 'X-H5CS-Features': 'human-contact' } : {}),
            },
          });
          expect(response.status).toBe(200);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(response.headers.get('vary')).toBe('X-H5CS-Features');
          const body = await response.json();
          expect(Object.keys(body).sort()).toEqual(['data', 'request_id']);
          const returned = isHistory ? body.data.snapshot : body.data;
          if (enabled) expect(returned.humanContact).toBe(published.humanContact);
          else {
            expect(returned).not.toHaveProperty('humanContact');
            expect(Object.keys(returned).sort()).toEqual(
              [
                'publicAssistantId',
                'merchantDisplayName',
                'assistantDisplayName',
                'aiDisclosure',
                'businessScope',
                'welcomeMessage',
                'availability',
                'releaseRef',
              ].sort(),
            );
          }
        }
      }
      const unauthorized = await fetch(
        `${await app.getUrl()}/api/v1/public/sessions/${handle}/history`,
        { headers: { 'X-H5CS-Features': 'human-contact' } },
      );
      expect(unauthorized.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
