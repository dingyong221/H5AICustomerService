import { randomBytes, randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { afterAll, describe, expect, it } from 'vitest';

import {
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlConversationTurnJobRepository,
  MySqlMerchantAccessRepository,
  MySqlPlatformProvisioningRepository,
  MerchantProvisionAlreadyAppliedError,
  MerchantProvisionIdempotencyConflictError,
} from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId } from '@h5cs/domain';

import { AppModule } from '../src/app.module.js';

const databaseUrl = process.env['H5CS_INTEGRATION_MYSQL_URL'];
if (!databaseUrl) throw new Error('A dedicated integration MySQL URL is required');
const target = new URL(databaseUrl);
if (
  target.protocol !== 'mysql:' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.pathname !== '/h5cs_integration_ci' ||
  target.username !== 'h5cs_ci' ||
  target.search !== '' ||
  target.hash !== ''
) {
  throw new Error('Integration tests only run against the dedicated loopback CI database');
}
const loaded = loadDatabaseConfig({
  MYSQL_DATABASE_URL: databaseUrl,
  NODE_ENV: 'test',
  APP_ENV: 'test',
});
if (!loaded.configured) throw new Error('The dedicated integration MySQL URL is unavailable');
const database = loaded.config;

const uniqueHex = (): string => randomBytes(16).toString('hex');
const idempotency = () => ({
  actorScopeDigest: randomBytes(32),
  keyDigest: randomBytes(32),
  requestHash: randomBytes(32),
  expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
});

async function dataFrom<T>(response: Response, expectedStatus: number): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw).toBe(expectedStatus);
  const payload = JSON.parse(raw) as { data?: T };
  expect(payload.data).toBeDefined();
  return payload.data!;
}

describe('real MySQL merchant-to-consumer flow', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;

  afterAll(async () => {
    await app?.close();
  });

  it('keeps a retried operator request to one merchant without replaying its one-time token', async () => {
    const repository = new MySqlPlatformProvisioningRepository(database);
    const name = `CI 幂等商家 ${uniqueHex()}`;
    const idempotencyKey = randomUUID();
    const input = { name, operatorId: 'integration_operator', idempotencyKey };
    const created = await repository.provisionMerchant(input);
    await expect(repository.provisionMerchant(input)).rejects.toMatchObject({
      name: MerchantProvisionAlreadyAppliedError.name,
      merchantId: created.id,
    });
    await expect(
      repository.provisionMerchant({ ...input, name: `${name} 修改` }),
    ).rejects.toBeInstanceOf(MerchantProvisionIdempotencyConflictError);
    expect(
      (await repository.listMerchants()).filter((merchant) => merchant.name === name),
    ).toHaveLength(1);
  });

  it('provisions, claims, publishes and serves one isolated completed consultation', async () => {
    const now = new Date();
    const provisioner = new MySqlPlatformProvisioningRepository(database);
    const merchant = await provisioner.provisionMerchant({
      name: `CI 测试商家 ${uniqueHex()}`,
      operatorId: 'integration_operator',
    });
    const access = new MySqlMerchantAccessRepository(
      database,
      randomBytes(32).toString('base64url'),
    );
    const owner = await access.claimInvitation({
      setupToken: merchant.setupToken,
      phone: '13800138000',
      password: 'integration-test-password-123',
    });
    expect(owner.merchantId).toBe(merchant.id);
    expect(
      await access.resolveSession(owner.sessionToken, merchant.id, owner.csrfToken),
    ).toMatchObject({ merchantId: merchant.id, merchantUserId: owner.merchantUserId });

    const merchantId = toMerchantId(merchant.id);
    const merchantUserId = toMerchantUserId(owner.merchantUserId);
    const assistants = new MySqlAssistantLifecycleRepository(database);
    const draft = {
      industry: '家电清洗',
      businessScope: '提供家用空调清洗咨询',
      materialsSummary: '提供上门空调清洗服务；服务范围以商家确认为准',
      pricingSummary: '价格需联系商家确认',
      promotionSummary: '目前无已确认优惠',
      welcomeMessage: '您好，我是 AI 客服，请问想了解什么？',
      insufficientInfoMessage: '资料不足，暂时无法确认，请联系商家。',
    };
    const created = await assistants.createManualDraft({
      merchantUserId,
      merchantId,
      displayName: '空调清洗客服',
      draft,
      idempotency: idempotency(),
      now,
    });
    expect(created.status).toBe('draft_only');
    const otherMerchant = await provisioner.provisionMerchant({
      name: `CI 其他商家 ${uniqueHex()}`,
      operatorId: 'integration_operator',
    });
    const otherOwner = await access.claimInvitation({
      setupToken: otherMerchant.setupToken,
      phone: '13900139000',
      password: 'integration-test-password-456',
    });
    expect(
      await assistants.listMerchantAssistants(
        toMerchantUserId(otherOwner.merchantUserId),
        toMerchantId(otherMerchant.id),
      ),
    ).toEqual([]);
    expect(
      await assistants.findManagementSnapshot(
        toMerchantId(otherMerchant.id),
        toAssistantId(created.assistantId),
      ),
    ).toBeNull();
    await assistants.confirmDraftKnowledge({
      merchantUserId,
      merchantId,
      assistantId: toAssistantId(created.assistantId),
      expectedDraftRevision: created.draftRevision,
      now: new Date(),
    });
    const release = await assistants.publish({
      merchantUserId,
      merchantId,
      assistantId: toAssistantId(created.assistantId),
      expectedDraftRevision: created.draftRevision,
      promptTemplateVersion: 'integration-v1',
      retrievalPolicyVersion: 'integration-v1',
      modelPolicyVersion: 'integration-v1',
      idempotency: idempotency(),
      now: new Date(),
    });
    expect(release.releaseNo).toBe(1);
    const published = await assistants.findPublicSnapshot(created.publicSlug);
    expect(published).toMatchObject({
      publicAssistantId: created.publicSlug,
      releaseRef: release.releaseId,
      assistantName: created.displayName,
    });

    const revised = await assistants.saveDraft({
      merchantUserId,
      merchantId,
      assistantId: toAssistantId(created.assistantId),
      expectedRevision: created.draftRevision,
      draft: { ...draft, materialsSummary: '尚未发布的新服务资料' },
      now: new Date(),
    });
    expect(revised.draftRevision).toBe(2);
    expect((await assistants.findPublicSnapshot(created.publicSlug))?.releaseRef).toBe(
      release.releaseId,
    );

    const priorEnvironment = {
      MYSQL_DATABASE_URL: process.env['MYSQL_DATABASE_URL'],
      PUBLIC_CONVERSATION_ENABLED: process.env['PUBLIC_CONVERSATION_ENABLED'],
      CONSUMER_H5_ORIGIN: process.env['CONSUMER_H5_ORIGIN'],
      VISITOR_CREDENTIAL_HMAC_KEY: process.env['VISITOR_CREDENTIAL_HMAC_KEY'],
    };
    process.env['MYSQL_DATABASE_URL'] = databaseUrl;
    process.env['PUBLIC_CONVERSATION_ENABLED'] = 'true';
    process.env['CONSUMER_H5_ORIGIN'] = 'http://127.0.0.1:3001';
    process.env['VISITOR_CREDENTIAL_HMAC_KEY'] = randomBytes(32).toString('base64url');
    try {
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      const apiOrigin = await app.getUrl();
      const publicBase = `${apiOrigin}/api/v1/public`;
      const snapshot = await dataFrom<{ releaseRef: string }>(
        await fetch(`${publicBase}/assistants/${created.publicSlug}`),
        200,
      );
      expect(snapshot.releaseRef).toBe(release.releaseId);

      const sessionRequestId = `session_request_${uniqueHex()}`;
      const sessionResponse = await fetch(
        `${publicBase}/assistants/${created.publicSlug}/sessions`,
        { method: 'POST', headers: { 'Idempotency-Key': sessionRequestId } },
      );
      const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
      expect(cookie).toMatch(/^h5cs_visitor=[A-Za-z0-9_-]{43}$/u);
      const session = await dataFrom<{ sessionHandle: string; releaseRef: string }>(
        sessionResponse,
        201,
      );
      expect(session.releaseRef).toBe(release.releaseId);
      const otherSessionResponse = await fetch(
        `${publicBase}/assistants/${created.publicSlug}/sessions`,
        { method: 'POST', headers: { 'Idempotency-Key': `session_request_${uniqueHex()}` } },
      );
      const otherCookie = otherSessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
      expect(otherCookie).toMatch(/^h5cs_visitor=[A-Za-z0-9_-]{43}$/u);
      expect(otherCookie).not.toBe(cookie);
      const otherSession = await dataFrom<{ sessionHandle: string }>(otherSessionResponse, 201);
      expect(otherSession.sessionHandle).not.toBe(session.sessionHandle);
      expect(
        (
          await fetch(`${publicBase}/sessions/${session.sessionHandle}/history`, {
            headers: { Cookie: otherCookie! },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`${publicBase}/sessions/${otherSession.sessionHandle}/history`, {
            headers: { Cookie: cookie! },
          })
        ).status,
      ).toBe(404);
      const clientMessageId = `message_${uniqueHex()}`;
      const accepted = await dataFrom<{ turnId: string }>(
        await fetch(`${publicBase}/sessions/${session.sessionHandle}/messages`, {
          method: 'POST',
          headers: {
            Cookie: cookie!,
            'Content-Type': 'application/json',
            'Idempotency-Key': clientMessageId,
          },
          body: JSON.stringify({ clientMessageId, content: '你们提供什么服务？' }),
        }),
        202,
      );
      const repeated = await dataFrom<{ turnId: string }>(
        await fetch(`${publicBase}/sessions/${session.sessionHandle}/messages`, {
          method: 'POST',
          headers: {
            Cookie: cookie!,
            'Content-Type': 'application/json',
            'Idempotency-Key': clientMessageId,
          },
          body: JSON.stringify({ clientMessageId, content: '你们提供什么服务？' }),
        }),
        202,
      );
      expect(repeated.turnId).toBe(accepted.turnId);
      const unauthorizedMessageId = `message_${uniqueHex()}`;
      expect(
        (
          await fetch(`${publicBase}/sessions/${session.sessionHandle}/messages`, {
            method: 'POST',
            headers: {
              Cookie: otherCookie!,
              'Content-Type': 'application/json',
              'Idempotency-Key': unauthorizedMessageId,
            },
            body: JSON.stringify({
              clientMessageId: unauthorizedMessageId,
              content: '无权发送的消息',
            }),
          })
        ).status,
      ).toBe(404);
      const jobs = new MySqlConversationTurnJobRepository(database);
      const claim = await jobs.claimNext(new Date(), 'integration_ci_worker');
      expect(claim).toMatchObject({
        merchantId: merchant.id,
        assistantId: created.assistantId,
        releaseId: release.releaseId,
        turnId: accepted.turnId.replace(/^t_/u, ''),
      });
      expect(claim?.facts.materialsSummary).toBe(draft.materialsSummary);
      await jobs.complete(claim!, '提供上门空调清洗服务，具体范围请向商家确认。', new Date());

      const turn = await dataFrom<{
        state: string;
        messages: Array<{ role: string; content: string }>;
      }>(
        await fetch(`${publicBase}/sessions/${session.sessionHandle}/turns/${accepted.turnId}`, {
          headers: { Cookie: cookie! },
        }),
        200,
      );
      expect(turn.state).toBe('completed');
      expect(turn.messages.map((message) => message.role)).toEqual(['visitor', 'assistant']);
      expect(turn.messages[1]?.content).toContain('空调清洗');
      expect(
        (
          await fetch(`${publicBase}/sessions/${session.sessionHandle}/turns/${accepted.turnId}`, {
            headers: { Cookie: otherCookie! },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`${publicBase}/sessions/${session.sessionHandle}/end`, {
            method: 'POST',
            headers: { Cookie: otherCookie! },
          })
        ).status,
      ).toBe(404);
      expect((await fetch(`${publicBase}/sessions/${session.sessionHandle}/history`)).status).toBe(
        404,
      );
      const history = await dataFrom<{ messages: Array<{ role: string }> }>(
        await fetch(`${publicBase}/sessions/${session.sessionHandle}/history`, {
          headers: { Cookie: cookie! },
        }),
        200,
      );
      expect(history.messages).toHaveLength(2);
      const ended = await dataFrom<{ state: string }>(
        await fetch(`${publicBase}/sessions/${session.sessionHandle}/end`, {
          method: 'POST',
          headers: { Cookie: cookie! },
        }),
        200,
      );
      expect(ended.state).toBe('ended');
      expect(
        (
          await fetch(`${publicBase}/sessions/${session.sessionHandle}/history`, {
            headers: { Cookie: cookie! },
          })
        ).status,
      ).toBe(404);
    } finally {
      for (const [key, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
