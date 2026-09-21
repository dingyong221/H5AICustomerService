import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { UnavailableOnboardingRepository } from '@h5cs/database';
import type {
  AssistantManagementRecord,
  MerchantId,
  MerchantUserId,
  OnboardingRepository,
  OnboardingSessionId,
  OnboardingSessionRecord,
  OnboardingSnapshot,
  VerifiedExternalIdentity,
} from '@h5cs/domain';
import {
  createOnboardingSnapshot,
  toAssistantId,
  toMerchantId,
  toMerchantUserId,
  toOnboardingSessionId,
} from '@h5cs/domain';

import { SkillOnboardingApplicationService } from '../src/skill/skill-onboarding.service.js';
import { createRuntimeSkillOnboardingService } from '../src/skill/runtime.js';
import type { WorkBuddyAuthenticator } from '../src/skill/workbuddy-authenticator.js';
import {
  WorkBuddyAuthenticationUnavailableError,
  deriveExternalSubjectLookupKey,
} from '../src/skill/workbuddy-authenticator.js';

const identity: VerifiedExternalIdentity = {
  provider: 'workbuddy',
  issuer: 'https://workbuddy.example.test',
  audience: 'h5cs-skill',
  subjectLookupKey: randomBytes(32),
  subjectLookupKeyVersion: 1,
  phoneMatchVerifiedAt: null,
  verifiedAt: new Date('2026-09-21T00:00:00.000Z'),
};

class TestAuthenticator implements WorkBuddyAuthenticator {
  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async authenticateAccessToken(): Promise<VerifiedExternalIdentity> {
    await Promise.resolve();
    return identity;
  }
}

class TestRepository implements OnboardingRepository {
  readonly userId = toMerchantUserId('11111111111111111111111111111111');
  readonly merchantId = toMerchantId('22222222222222222222222222222222');
  session: OnboardingSessionRecord | null = null;
  generationResult: Readonly<{ merchantId: MerchantId; assistantId: string }> | undefined;
  assistants: readonly AssistantManagementRecord[] = [];

  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async resolveOrCreateMerchantUser(): Promise<{ id: MerchantUserId }> {
    await Promise.resolve();
    return { id: this.userId };
  }

  public async findMerchantBinding(): Promise<MerchantId | null> {
    await Promise.resolve();
    return this.merchantId;
  }

  public async listAssistants(): Promise<readonly AssistantManagementRecord[]> {
    await Promise.resolve();
    return this.assistants;
  }

  public async findLatestSession(): Promise<OnboardingSessionRecord | null> {
    await Promise.resolve();
    return this.session;
  }

  public async findSession(
    _merchantUserId: MerchantUserId,
    sessionId: OnboardingSessionId,
  ): Promise<OnboardingSessionRecord | null> {
    await Promise.resolve();
    return this.session?.id === sessionId ? this.session : null;
  }

  public async createSession(
    merchantUserId: MerchantUserId,
    snapshot: OnboardingSnapshot,
  ): Promise<OnboardingSessionRecord> {
    await Promise.resolve();
    this.session = {
      id: toOnboardingSessionId('33333333333333333333333333333333'),
      merchantUserId,
      merchantId: null,
      assistantId: null,
      snapshot,
      version: 1,
    };
    return this.session;
  }

  public async saveSession(
    session: OnboardingSessionRecord,
    nextSnapshot: OnboardingSnapshot,
  ): Promise<OnboardingSessionRecord> {
    await Promise.resolve();
    this.session = { ...session, snapshot: nextSnapshot, version: session.version + 1 };
    return this.session;
  }

  public async saveGenerationResult(
    session: OnboardingSessionRecord,
    nextSnapshot: OnboardingSnapshot,
    merchantId: MerchantId,
    assistantId: ReturnType<typeof toAssistantId>,
  ): Promise<OnboardingSessionRecord> {
    await Promise.resolve();
    this.generationResult = { merchantId, assistantId };
    this.session = {
      ...session,
      merchantId,
      assistantId,
      snapshot: nextSnapshot,
      version: session.version + 1,
    };
    return this.session;
  }
}

describe('Skill onboarding application service', () => {
  it('starts a persisted onboarding session without requiring a phone match', async () => {
    const repository = new TestRepository();
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      'https://console.example.test/',
    );

    const result = await service.execute('Bearer verified-token', {
      intent: 'create_customer_service',
    });

    expect(result.action).toBe('continue_onboarding');
    if (result.action !== 'continue_onboarding') return;
    expect(result.state).toBe('industry');
    expect(result.missing_items.map((item) => item.code)).toContain('offering');
  });

  it('records generated assistant ownership through the dedicated repository operation', async () => {
    const repository = new TestRepository();
    repository.session = {
      id: toOnboardingSessionId('33333333333333333333333333333333'),
      merchantUserId: repository.userId,
      merchantId: repository.merchantId,
      assistantId: null,
      snapshot: {
        ...createOnboardingSnapshot(),
        state: 'generating',
        answers: { merchantConfirmed: true },
      },
      version: 3,
    };
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      'https://console.example.test/',
    );

    await service.advance({
      authorizationHeader: 'Bearer verified-token',
      sessionId: '33333333333333333333333333333333',
      event: {
        type: 'generation_succeeded',
        assistantId: toAssistantId('44444444444444444444444444444444'),
      },
    });

    expect(repository.generationResult).toEqual({
      merchantId: repository.merchantId,
      assistantId: '44444444444444444444444444444444',
    });
  });

  it('returns generic help safely without authentication or database configuration', async () => {
    await expect(
      createRuntimeSkillOnboardingService({}).execute(undefined, { intent: 'help' }),
    ).resolves.toEqual({
      action: 'help',
      supported_intents: ['create_customer_service', 'open_management_console'],
    });
  });

  it('fails protected intents explicitly when authentication or persistence is unconfigured', async () => {
    await expect(
      createRuntimeSkillOnboardingService({}).execute('Bearer token', {
        intent: 'create_customer_service',
      }),
    ).rejects.toThrow(WorkBuddyAuthenticationUnavailableError);

    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      new UnavailableOnboardingRepository('MYSQL_DATABASE_URL is not set'),
    );
    await expect(
      service.execute('Bearer token', { intent: 'create_customer_service' }),
    ).rejects.toThrow('MYSQL_DATABASE_URL is not set');
  });

  it('distinguishes zero, one, and multiple assistants without merchant IDs in URLs', async () => {
    const repository = new TestRepository();
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      'https://console.example.test/manage',
    );

    await expect(
      service.execute('Bearer token', { intent: 'open_management_console' }),
    ).resolves.toEqual({ action: 'start_first_onboarding', reason: 'no_assistant' });

    repository.assistants = [
      { id: toAssistantId('44444444444444444444444444444444'), status: 'active' },
    ];
    const one = await service.execute('Bearer token', { intent: 'open_management_console' });
    expect(one).toEqual({
      action: 'open_management_console',
      url: 'https://console.example.test/manage',
      assistant: { assistant_ref: '44444444444444444444444444444444', status: 'active' },
    });
    expect(one.action === 'open_management_console' ? one.url : '').not.toContain(
      '22222222222222222222222222222222',
    );

    repository.assistants = [
      { id: toAssistantId('44444444444444444444444444444444'), status: 'active' },
      { id: toAssistantId('55555555555555555555555555555555'), status: 'paused' },
    ];
    const many = await service.execute('Bearer token', { intent: 'open_management_console' });
    expect(many.action).toBe('select_assistant');
    if (many.action === 'select_assistant') {
      expect(many.selection_required).toBe(true);
      expect(many.assistants).toHaveLength(2);
    }
  });
});

describe('WorkBuddy external subject lookup', () => {
  it('uses issuer and audience as HMAC context and never needs a caller password', () => {
    const secret = randomBytes(32);
    const base = {
      provider: 'workbuddy' as const,
      issuer: 'https://workbuddy.example.test',
      audience: 'h5cs-skill',
      openId: 'stable-open-id',
      lookupKeyVersion: 1,
    };
    const first = deriveExternalSubjectLookupKey(base, secret);
    const second = deriveExternalSubjectLookupKey(base, secret);
    const otherAudience = deriveExternalSubjectLookupKey(
      { ...base, audience: 'another-client' },
      secret,
    );
    const metadataOnlyVersionChange = deriveExternalSubjectLookupKey(
      { ...base, lookupKeyVersion: 2 },
      secret,
    );
    const rotatedKey = deriveExternalSubjectLookupKey(base, randomBytes(32));

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first).equals(Buffer.from(otherAudience))).toBe(false);
    expect(Buffer.from(first).equals(Buffer.from(metadataOnlyVersionChange))).toBe(true);
    expect(Buffer.from(first).equals(Buffer.from(rotatedKey))).toBe(false);
    expect(first.byteLength).toBe(32);
  });

  it('uses length prefixes so ambiguous segment boundaries cannot collide', () => {
    const secret = randomBytes(32);
    const common = {
      provider: 'workbuddy' as const,
      openId: 'stable-open-id',
      lookupKeyVersion: 1,
    };
    const first = deriveExternalSubjectLookupKey(
      { ...common, issuer: 'a', audience: 'b\0c' },
      secret,
    );
    const second = deriveExternalSubjectLookupKey(
      { ...common, issuer: 'a\0b', audience: 'c' },
      secret,
    );

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });
});
