import type { SkillIntentRequest, SkillIntentResult } from '@h5cs/contracts';
import type { OnboardingEvent, OnboardingRepository, OnboardingSessionRecord } from '@h5cs/domain';
import {
  createOnboardingSnapshot,
  getOnboardingMissingItems,
  toOnboardingSessionId,
  transitionOnboarding,
} from '@h5cs/domain';

import type { WorkBuddyAuthenticator } from './workbuddy-authenticator.js';
import { WorkBuddyAuthenticationRequiredError } from './workbuddy-authenticator.js';

export class MerchantBindingRequiredError extends Error {
  public constructor() {
    super('The WorkBuddy identity is not bound to a merchant');
    this.name = 'MerchantBindingRequiredError';
  }
}

export class OnboardingSessionNotFoundError extends Error {
  public constructor() {
    super('The onboarding session was not found for this WorkBuddy identity');
    this.name = 'OnboardingSessionNotFoundError';
  }
}

export class ManagementConsoleUnavailableError extends Error {
  public constructor() {
    super('The management console URL is not configured');
    this.name = 'ManagementConsoleUnavailableError';
  }
}

export type AdvanceOnboardingCommand = Readonly<{
  authorizationHeader: string;
  sessionId: string;
  event: OnboardingEvent;
}>;

export class SkillOnboardingApplicationService {
  readonly #authenticator: WorkBuddyAuthenticator;
  readonly #repository: OnboardingRepository;
  readonly #managementConsoleUrl: string | undefined;

  public constructor(
    authenticator: WorkBuddyAuthenticator,
    repository: OnboardingRepository,
    managementConsoleUrl?: string,
  ) {
    this.#authenticator = authenticator;
    this.#repository = repository;
    this.#managementConsoleUrl = managementConsoleUrl;
  }

  public async execute(
    authorizationHeader: string | undefined,
    request: SkillIntentRequest,
  ): Promise<SkillIntentResult> {
    if (request.intent === 'help') {
      return {
        action: 'help',
        supported_intents: ['create_customer_service', 'open_management_console'],
      };
    }

    const { merchantUserId } = await this.#resolveMerchantUser(authorizationHeader);

    switch (request.intent) {
      case 'open_management_console': {
        const merchantId = await this.#repository.findMerchantBinding(merchantUserId);
        if (merchantId === null) throw new MerchantBindingRequiredError();
        const assistants = await this.#repository.listAssistants(merchantId);
        if (assistants.length === 0) {
          return { action: 'start_first_onboarding', reason: 'no_assistant' };
        }
        const url = this.#managementUrl();
        if (assistants.length === 1) {
          const assistant = assistants[0];
          if (assistant === undefined) throw new Error('Assistant list invariant failed');
          return {
            action: 'open_management_console',
            url,
            assistant: { assistant_ref: assistant.id, status: assistant.status },
          };
        }
        return {
          action: 'select_assistant',
          url,
          selection_required: true,
          assistants: assistants.map((assistant) => ({
            assistant_ref: assistant.id,
            status: assistant.status,
          })),
        };
      }
      case 'create_customer_service': {
        const session = await this.#resolveOnboardingSession(
          merchantUserId,
          request.resume_session_id,
        );
        return this.#toResult(session);
      }
    }
  }

  public async advance(command: AdvanceOnboardingCommand): Promise<SkillIntentResult> {
    const { merchantUserId } = await this.#resolveMerchantUser(command.authorizationHeader);
    const session = await this.#repository.findSession(
      merchantUserId,
      toOnboardingSessionId(command.sessionId),
    );
    if (session === null) throw new OnboardingSessionNotFoundError();

    const nextSnapshot = transitionOnboarding(session.snapshot, command.event);
    let saved: OnboardingSessionRecord;
    if (command.event.type === 'generation_succeeded') {
      const merchantId =
        session.merchantId ?? (await this.#repository.findMerchantBinding(merchantUserId));
      if (merchantId === null) throw new MerchantBindingRequiredError();
      saved = await this.#repository.saveGenerationResult(
        session,
        nextSnapshot,
        merchantId,
        command.event.assistantId,
      );
    } else {
      saved = await this.#repository.saveSession(session, nextSnapshot);
    }
    return this.#toResult(saved);
  }

  async #resolveMerchantUser(authorizationHeader: string | undefined): Promise<{
    merchantUserId: Awaited<ReturnType<OnboardingRepository['resolveOrCreateMerchantUser']>>['id'];
  }> {
    if (authorizationHeader === undefined || !authorizationHeader.startsWith('Bearer ')) {
      throw new WorkBuddyAuthenticationRequiredError();
    }

    await this.#authenticator.assertReady();
    await this.#repository.assertReady();
    const identity = await this.#authenticator.authenticateAccessToken(authorizationHeader);
    const merchantUser = await this.#repository.resolveOrCreateMerchantUser(identity);
    return { merchantUserId: merchantUser.id };
  }

  async #resolveOnboardingSession(
    merchantUserId: Awaited<ReturnType<OnboardingRepository['resolveOrCreateMerchantUser']>>['id'],
    requestedSessionId: string | undefined,
  ): Promise<OnboardingSessionRecord> {
    if (requestedSessionId !== undefined) {
      const requested = await this.#repository.findSession(
        merchantUserId,
        toOnboardingSessionId(requestedSessionId),
      );
      if (requested === null) throw new OnboardingSessionNotFoundError();
      return requested;
    }

    const existing = await this.#repository.findLatestSession(merchantUserId);
    return existing ?? this.#repository.createSession(merchantUserId, createOnboardingSnapshot());
  }

  #toResult(session: OnboardingSessionRecord): SkillIntentResult {
    return {
      action: 'continue_onboarding',
      onboarding_session_id: session.id,
      state: session.snapshot.state,
      missing_items: [...getOnboardingMissingItems(session.snapshot)],
    };
  }

  #managementUrl(): string {
    if (this.#managementConsoleUrl === undefined) {
      throw new ManagementConsoleUnavailableError();
    }
    return new URL(this.#managementConsoleUrl).toString();
  }
}
