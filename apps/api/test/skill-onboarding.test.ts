import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

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
  transitionOnboarding,
} from '@h5cs/domain';

import {
  ManagementConsoleUnavailableError,
  MerchantBindingRequiredError,
  OnboardingSessionNotFoundError,
  SkillOnboardingApplicationService,
} from '../src/skill/skill-onboarding.service.js';
import { createRuntimeSkillOnboardingService } from '../src/skill/runtime.js';
import type { GenerationCoordinator } from '../src/skill/generation-coordinator.js';
import {
  GenerationUnavailableError,
  UnavailableGenerationCoordinator,
} from '../src/skill/generation-coordinator.js';
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

const readyGenerationCoordinator: GenerationCoordinator = {
  assertReady: async () => Promise.resolve(),
  generate: async () => toAssistantId('44444444444444444444444444444444'),
};

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
    merchantId: MerchantId,
    snapshot: OnboardingSnapshot,
  ): Promise<OnboardingSessionRecord> {
    await Promise.resolve();
    this.session = {
      id: toOnboardingSessionId('33333333333333333333333333333333'),
      merchantUserId,
      merchantId,
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
  it('authenticates the bearer token before probing or resolving persistence', async () => {
    const calls: string[] = [];
    const repository = new TestRepository();
    repository.assertReady = async () => {
      calls.push('repository.assertReady');
    };
    repository.resolveOrCreateMerchantUser = async () => {
      calls.push('repository.resolveOrCreateMerchantUser');
      return { id: repository.userId };
    };
    const authenticator: WorkBuddyAuthenticator = {
      assertReady: async () => {
        calls.push('authenticator.assertReady');
      },
      authenticateAccessToken: async () => {
        calls.push('authenticator.authenticateAccessToken');
        return identity;
      },
    };
    const service = new SkillOnboardingApplicationService(
      authenticator,
      repository,
      readyGenerationCoordinator,
    );

    await service.execute('Bearer verified-token', { intent: 'create_customer_service' });

    expect(calls).toEqual([
      'authenticator.assertReady',
      'authenticator.authenticateAccessToken',
      'repository.assertReady',
      'repository.resolveOrCreateMerchantUser',
    ]);
  });

  it('does not touch persistence when bearer token authentication fails', async () => {
    let repositoryTouched = false;
    const repository = new TestRepository();
    repository.assertReady = async () => {
      repositoryTouched = true;
    };
    const authenticator: WorkBuddyAuthenticator = {
      assertReady: async () => undefined,
      authenticateAccessToken: async () => {
        throw new Error('invalid token');
      },
    };
    const service = new SkillOnboardingApplicationService(
      authenticator,
      repository,
      readyGenerationCoordinator,
    );

    await expect(
      service.execute('Bearer invalid-token', { intent: 'create_customer_service' }),
    ).rejects.toThrow('invalid token');
    expect(repositoryTouched).toBe(false);
  });

  it('starts a persisted onboarding session without requiring a phone match', async () => {
    const repository = new TestRepository();
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      readyGenerationCoordinator,
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

  it('offers active industry guidance without saving it as merchant facts', async () => {
    const repository = new TestRepository();
    let active = true;
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      readyGenerationCoordinator,
      'https://console.example.test/',
      {
        listActive: async () =>
          active
            ? [
                {
                  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  code: 'home_service',
                  version: 2,
                  status: 'active',
                  displayName: '家居服务',
                  referenceNotes: '请核实是否提供上门服务。',
                  requiredMaterials: ['服务项目', '服务范围'],
                  requiredPolicies: ['报价条件'],
                },
              ]
            : [],
      },
    );
    const start = await service.execute('Bearer verified-token', {
      intent: 'create_customer_service',
    });
    expect(start).toMatchObject({
      action: 'continue_onboarding',
      state: 'industry',
      industry_options: [{ code: 'home_service', display_name: '家居服务', version: 2 }],
    });
    if (start.action !== 'continue_onboarding') return;
    const next = await service.advance({
      authorizationHeader: 'Bearer verified-token',
      sessionId: start.onboarding_session_id,
      event: { type: 'provide_industry', industryCode: 'home_service' },
    });
    expect(next).toMatchObject({
      action: 'continue_onboarding',
      state: 'materials',
      industry_guide: {
        code: 'home_service',
        reference_notes: '请核实是否提供上门服务。',
        required_materials: ['服务项目', '服务范围'],
        required_policies: ['报价条件'],
      },
    });
    expect(repository.session?.snapshot.answers).toEqual({
      industryCode: 'home_service',
      merchantConfirmed: false,
    });
    active = false;
    const resumed = await service.execute('Bearer verified-token', {
      intent: 'create_customer_service',
      resume_session_id: start.onboarding_session_id,
    });
    if (resumed.action !== 'continue_onboarding') return;
    expect(resumed.industry_guide).toBeUndefined();
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
      readyGenerationCoordinator,
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

  it('fails closed before transition or persistence when generation is unavailable', async () => {
    const repository = new TestRepository();
    repository.session = {
      id: toOnboardingSessionId('33333333333333333333333333333333'),
      merchantUserId: repository.userId,
      merchantId: repository.merchantId,
      assistantId: null,
      snapshot: {
        state: 'confirmation',
        answers: {},
      },
      version: 7,
    };
    let saveCalled = false;
    repository.saveSession = async (session, nextSnapshot) => {
      saveCalled = true;
      return { ...session, snapshot: nextSnapshot };
    };
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      new UnavailableGenerationCoordinator('generation dispatcher is not configured'),
      'https://console.example.test/',
    );

    await expect(
      service.advance({
        authorizationHeader: 'Bearer verified-token',
        sessionId: '33333333333333333333333333333333',
        event: { type: 'confirm' },
      }),
    ).rejects.toThrow(GenerationUnavailableError);
    expect(saveCalled).toBe(false);
    expect(repository.session.snapshot.state).toBe('confirmation');
    expect(repository.session.version).toBe(7);
  });

  it('generates one manageable draft after confirmation and routes later entry to management', async () => {
    const repository = new TestRepository();
    const assistantId = toAssistantId('44444444444444444444444444444444');
    const confirmation = {
      state: 'confirmation' as const,
      answers: {
        industryCode: 'home_service',
        businessName: '安心服务',
        businessDescription: '提供家电清洗服务',
        offerings: [
          {
            kind: 'service' as const,
            name: '空调清洗',
            description: '挂机空调清洗服务',
            targetAudience: '本地家庭用户',
          },
        ],
        materials: [{ kind: 'faq' as const, reference: 'faq:cleaning-v1', summary: '服务范围' }],
        pricingPolicy: { availability: 'none_confirmed' as const, facts: [] },
        promotionPolicy: { availability: 'unknown' as const, facts: [] },
        insufficientFactPolicy: 'say_unconfirmed' as const,
        merchantConfirmed: false,
      },
    };
    repository.session = {
      id: toOnboardingSessionId('33333333333333333333333333333333'),
      merchantUserId: repository.userId,
      merchantId: repository.merchantId,
      assistantId: null,
      snapshot: confirmation,
      version: 3,
    };
    const generate = vi.fn<GenerationCoordinator['generate']>(async (session, merchantId) => {
      expect(session.snapshot.state).toBe('generating');
      expect(session.snapshot.answers.merchantConfirmed).toBe(true);
      expect(merchantId).toBe(repository.merchantId);
      repository.session = {
        ...session,
        assistantId,
        snapshot: transitionOnboarding(session.snapshot, {
          type: 'generation_succeeded',
          assistantId,
        }),
        version: session.version + 1,
      };
      repository.assistants = [{ id: assistantId, displayName: '新客服', status: 'draft_only' }];
      return assistantId;
    });
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      { assertReady: async () => undefined, generate },
      'https://console.example.test/',
    );

    await expect(
      service.advance({
        authorizationHeader: 'Bearer token',
        sessionId: repository.session.id,
        event: { type: 'confirm' },
      }),
    ).resolves.toMatchObject({
      action: 'continue_onboarding',
      state: 'manageable',
      management_url:
        'https://console.example.test/workspace/22222222222222222222222222222222/assistants/44444444444444444444444444444444',
    });
    expect(generate).toHaveBeenCalledOnce();
    await expect(
      service.execute('Bearer token', { intent: 'create_customer_service' }),
    ).resolves.toMatchObject({ action: 'open_management_console' });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('retries an uncertain generating session with the same durable session ownership', async () => {
    const repository = new TestRepository();
    repository.session = {
      id: toOnboardingSessionId('33333333333333333333333333333333'),
      merchantUserId: repository.userId,
      merchantId: repository.merchantId,
      assistantId: null,
      snapshot: {
        state: 'generating',
        answers: { merchantConfirmed: true },
      },
      version: 7,
    };
    const assistantId = toAssistantId('44444444444444444444444444444444');
    let attempts = 0;
    const generate = vi.fn<GenerationCoordinator['generate']>(async (session) => {
      attempts += 1;
      if (attempts === 1) throw new Error('unknown database outcome');
      return assistantId;
    });
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      { assertReady: async () => undefined, generate },
      'https://console.example.test/console',
    );

    await expect(
      service.execute('Bearer token', { intent: 'create_customer_service' }),
    ).rejects.toThrow('unknown database outcome');
    await expect(
      service.execute('Bearer token', { intent: 'create_customer_service' }),
    ).resolves.toMatchObject({
      action: 'continue_onboarding',
      state: 'manageable',
      management_url:
        'https://console.example.test/console/workspace/22222222222222222222222222222222/assistants/44444444444444444444444444444444',
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0]?.[0].id).toBe(generate.mock.calls[1]?.[0].id);
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
      readyGenerationCoordinator,
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
      readyGenerationCoordinator,
      'https://console.example.test/',
    );

    await expect(
      service.execute('Bearer token', { intent: 'open_management_console' }),
    ).resolves.toEqual({ action: 'start_first_onboarding', reason: 'no_assistant' });

    repository.assistants = [
      {
        id: toAssistantId('44444444444444444444444444444444'),
        displayName: '售前客服',
        status: 'active',
      },
    ];
    const one = await service.execute('Bearer token', { intent: 'open_management_console' });
    expect(one).toEqual({
      action: 'open_management_console',
      url: 'https://console.example.test/workspace/22222222222222222222222222222222/assistants/44444444444444444444444444444444',
      assistant: {
        assistant_ref: '44444444444444444444444444444444',
        display_name: '售前客服',
        status: 'active',
      },
    });
    expect(one.action === 'open_management_console' ? one.url : '').not.toContain('token');

    repository.assistants = [
      {
        id: toAssistantId('44444444444444444444444444444444'),
        displayName: '售前客服',
        status: 'active',
      },
      {
        id: toAssistantId('55555555555555555555555555555555'),
        displayName: '售后客服',
        status: 'paused',
      },
    ];
    const many = await service.execute('Bearer token', { intent: 'open_management_console' });
    expect(many.action).toBe('select_assistant');
    if (many.action === 'select_assistant') {
      expect(many.selection_required).toBe(true);
      expect(many.assistants).toHaveLength(2);
      expect(many.assistants.map((assistant) => assistant.display_name)).toEqual([
        '售前客服',
        '售后客服',
      ]);
    }

    await expect(
      service.execute('Bearer token', {
        intent: 'open_management_console',
        assistant_ref: '55555555555555555555555555555555',
      }),
    ).resolves.toEqual({
      action: 'open_management_console',
      url: 'https://console.example.test/workspace/22222222222222222222222222222222/assistants/55555555555555555555555555555555',
      assistant: {
        assistant_ref: '55555555555555555555555555555555',
        display_name: '售后客服',
        status: 'paused',
      },
    });
    await expect(
      service.execute('Bearer token', {
        intent: 'open_management_console',
        assistant_ref: '66666666666666666666666666666666',
      }),
    ).rejects.toThrow('The assistant is not available to this merchant');
  });

  it('routes first-time creation to the existing assistant instead of starting another onboarding', async () => {
    const repository = new TestRepository();
    const createSession = vi.spyOn(repository, 'createSession');
    const findSession = vi.spyOn(repository, 'findSession');
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      readyGenerationCoordinator,
      'https://console.example.test/',
    );
    repository.assistants = [
      {
        id: toAssistantId('44444444444444444444444444444444'),
        displayName: '售前客服',
        status: 'active',
      },
    ];

    await expect(
      service.execute('Bearer token', {
        intent: 'create_customer_service',
        resume_session_id: '33333333333333333333333333333333',
      }),
    ).resolves.toEqual({
      action: 'open_management_console',
      url: 'https://console.example.test/workspace/22222222222222222222222222222222/assistants/44444444444444444444444444444444',
      assistant: {
        assistant_ref: '44444444444444444444444444444444',
        display_name: '售前客服',
        status: 'active',
      },
    });
    repository.assistants = [
      ...repository.assistants,
      {
        id: toAssistantId('55555555555555555555555555555555'),
        displayName: '售后客服',
        status: 'paused',
      },
    ];
    const multiple = await service.execute('Bearer token', { intent: 'create_customer_service' });
    expect(multiple.action).toBe('select_assistant');
    expect(createSession).not.toHaveBeenCalled();
    expect(findSession).not.toHaveBeenCalled();
  });

  it('rejects an unapproved management path rather than returning a misleading link', async () => {
    const repository = new TestRepository();
    repository.assistants = [
      {
        id: toAssistantId('44444444444444444444444444444444'),
        displayName: '售前客服',
        status: 'active',
      },
    ];
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      readyGenerationCoordinator,
      'https://console.example.test/unrelated',
    );
    await expect(
      service.execute('Bearer token', { intent: 'open_management_console' }),
    ).rejects.toBeInstanceOf(ManagementConsoleUnavailableError);
  });

  it('does not create onboarding without an active merchant binding', async () => {
    const repository = new TestRepository();
    repository.findMerchantBinding = async () => null;
    const createSession = vi.spyOn(repository, 'createSession');
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      readyGenerationCoordinator,
    );

    await expect(
      service.execute('Bearer token', { intent: 'create_customer_service' }),
    ).rejects.toBeInstanceOf(MerchantBindingRequiredError);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects an onboarding session pinned to a different merchant', async () => {
    const repository = new TestRepository();
    repository.session = {
      id: toOnboardingSessionId('33333333333333333333333333333333'),
      merchantUserId: repository.userId,
      merchantId: toMerchantId('99999999999999999999999999999999'),
      assistantId: null,
      snapshot: createOnboardingSnapshot(),
      version: 1,
    };
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      readyGenerationCoordinator,
    );

    await expect(
      service.execute('Bearer token', {
        intent: 'create_customer_service',
        resume_session_id: '33333333333333333333333333333333',
      }),
    ).rejects.toBeInstanceOf(OnboardingSessionNotFoundError);
  });

  it('checks the active merchant binding again before changing onboarding answers', async () => {
    const repository = new TestRepository();
    repository.session = {
      id: toOnboardingSessionId('33333333333333333333333333333333'),
      merchantUserId: repository.userId,
      merchantId: repository.merchantId,
      assistantId: null,
      snapshot: createOnboardingSnapshot(),
      version: 1,
    };
    repository.findMerchantBinding = async () => null;
    const saveSession = vi.spyOn(repository, 'saveSession');
    const service = new SkillOnboardingApplicationService(
      new TestAuthenticator(),
      repository,
      readyGenerationCoordinator,
    );

    await expect(
      service.advance({
        authorizationHeader: 'Bearer token',
        sessionId: '33333333333333333333333333333333',
        event: { type: 'provide_industry', industryCode: 'retail' },
      }),
    ).rejects.toBeInstanceOf(MerchantBindingRequiredError);
    expect(saveSession).not.toHaveBeenCalled();
  });
});

describe('WorkBuddy external subject lookup', () => {
  it('uses issuer and third-party client ID as HMAC context and never needs a caller password', () => {
    const secret = randomBytes(32);
    const base = {
      issuer: 'https://workbuddy.example.test',
      clientId: 'h5cs-skill',
      openId: 'stable-open-id',
      lookupKeyVersion: 1,
    };
    const first = deriveExternalSubjectLookupKey(base, secret);
    const second = deriveExternalSubjectLookupKey(base, secret);
    const otherClient = deriveExternalSubjectLookupKey(
      { ...base, clientId: 'another-client' },
      secret,
    );
    const metadataOnlyVersionChange = deriveExternalSubjectLookupKey(
      { ...base, lookupKeyVersion: 2 },
      secret,
    );
    const rotatedKey = deriveExternalSubjectLookupKey(base, randomBytes(32));
    const expected = createHmac('sha256', secret);
    for (const value of [base.issuer, base.clientId, base.openId]) {
      const bytes = Buffer.from(value, 'utf8');
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(bytes.byteLength);
      expected.update(length).update(bytes);
    }

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first).equals(expected.digest())).toBe(true);
    expect(Buffer.from(first).equals(Buffer.from(otherClient))).toBe(false);
    expect(Buffer.from(first).equals(Buffer.from(metadataOnlyVersionChange))).toBe(true);
    expect(Buffer.from(first).equals(Buffer.from(rotatedKey))).toBe(false);
    expect(first.byteLength).toBe(32);
  });

  it('uses length prefixes so ambiguous segment boundaries cannot collide', () => {
    const secret = randomBytes(32);
    const common = {
      openId: 'stable-open-id',
      lookupKeyVersion: 1,
    };
    const first = deriveExternalSubjectLookupKey(
      { ...common, issuer: 'a', clientId: 'b\0c' },
      secret,
    );
    const second = deriveExternalSubjectLookupKey(
      { ...common, issuer: 'a\0b', clientId: 'c' },
      secret,
    );

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });
});
