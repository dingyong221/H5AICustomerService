import type { SkillIntentRequest, SkillIntentResult } from '@h5cs/contracts';
import type { IndustryTemplateGuide } from '@h5cs/database';
import type {
  MerchantId,
  MerchantUserId,
  OnboardingEvent,
  OnboardingRepository,
  OnboardingSessionRecord,
} from '@h5cs/domain';
import {
  createOnboardingSnapshot,
  getOnboardingMissingItems,
  toOnboardingSessionId,
  transitionOnboarding,
} from '@h5cs/domain';

import type { WorkBuddyAuthenticator } from './workbuddy-authenticator.js';
import { WorkBuddyAuthenticationRequiredError } from './workbuddy-authenticator.js';
import type { GenerationCoordinator } from './generation-coordinator.js';

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

export class AssistantSelectionNotFoundError extends Error {
  public constructor() {
    super('The assistant is not available to this merchant');
    this.name = 'AssistantSelectionNotFoundError';
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

export interface IndustryGuideCatalog {
  listActive(): Promise<readonly IndustryTemplateGuide[]>;
}

export class SkillOnboardingApplicationService {
  readonly #authenticator: WorkBuddyAuthenticator;
  readonly #repository: OnboardingRepository;
  readonly #generationCoordinator: GenerationCoordinator;
  readonly #managementConsoleUrl: string | undefined;
  readonly #industryGuides: IndustryGuideCatalog | undefined;

  public constructor(
    authenticator: WorkBuddyAuthenticator,
    repository: OnboardingRepository,
    generationCoordinator: GenerationCoordinator,
    managementConsoleUrl?: string,
    industryGuides?: IndustryGuideCatalog,
  ) {
    this.#authenticator = authenticator;
    this.#repository = repository;
    this.#generationCoordinator = generationCoordinator;
    this.#managementConsoleUrl = managementConsoleUrl;
    this.#industryGuides = industryGuides;
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
        const assistants = await this.#repository.listAssistants(merchantId, merchantUserId);
        if (assistants.length === 0) {
          if (request.assistant_ref !== undefined) throw new AssistantSelectionNotFoundError();
          return { action: 'start_first_onboarding', reason: 'no_assistant' };
        }
        return this.#existingAssistantsResult(merchantId, assistants, request.assistant_ref);
      }
      case 'create_customer_service': {
        const merchantId = await this.#repository.findMerchantBinding(merchantUserId);
        if (merchantId === null) throw new MerchantBindingRequiredError();
        const assistants = await this.#repository.listAssistants(merchantId, merchantUserId);
        if (assistants.length > 0) return this.#existingAssistantsResult(merchantId, assistants);
        const session = await this.#resolveOnboardingSession(
          merchantUserId,
          merchantId,
          request.resume_session_id,
        );
        if (session.snapshot.state === 'generating') {
          return this.#finishGenerating(session, merchantId);
        }
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
    const merchantId = await this.#repository.findMerchantBinding(merchantUserId);
    if (merchantId === null) throw new MerchantBindingRequiredError();
    if (session.merchantId !== merchantId) {
      throw new OnboardingSessionNotFoundError();
    }

    if (command.event.type === 'confirm') {
      this.#managementUrl();
      await this.#generationCoordinator.assertReady();
      if (session.snapshot.state === 'generating') {
        return this.#finishGenerating(session, merchantId);
      }
    }

    const nextSnapshot = transitionOnboarding(session.snapshot, command.event);
    let saved: OnboardingSessionRecord;
    if (command.event.type === 'generation_succeeded') {
      saved = await this.#repository.saveGenerationResult(
        session,
        nextSnapshot,
        merchantId,
        command.event.assistantId,
      );
    } else {
      saved = await this.#repository.saveSession(session, nextSnapshot);
    }
    if (command.event.type === 'confirm') return this.#finishGenerating(saved, merchantId);
    return this.#toResult(saved);
  }

  async #resolveMerchantUser(authorizationHeader: string | undefined): Promise<{
    merchantUserId: Awaited<ReturnType<OnboardingRepository['resolveOrCreateMerchantUser']>>['id'];
  }> {
    if (authorizationHeader === undefined || !authorizationHeader.startsWith('Bearer ')) {
      throw new WorkBuddyAuthenticationRequiredError();
    }

    await this.#authenticator.assertReady();
    const identity = await this.#authenticator.authenticateAccessToken(authorizationHeader);
    await this.#repository.assertReady();
    const merchantUser = await this.#repository.resolveOrCreateMerchantUser(identity);
    return { merchantUserId: merchantUser.id };
  }

  async #resolveOnboardingSession(
    merchantUserId: MerchantUserId,
    merchantId: MerchantId,
    requestedSessionId: string | undefined,
  ): Promise<OnboardingSessionRecord> {
    if (requestedSessionId !== undefined) {
      const requested = await this.#repository.findSession(
        merchantUserId,
        toOnboardingSessionId(requestedSessionId),
      );
      if (requested === null || requested.merchantId !== merchantId) {
        throw new OnboardingSessionNotFoundError();
      }
      return requested;
    }

    const existing = await this.#repository.findLatestSession(merchantUserId);
    return existing?.merchantId === merchantId
      ? existing
      : this.#repository.createSession(merchantUserId, merchantId, createOnboardingSnapshot());
  }

  async #finishGenerating(
    session: OnboardingSessionRecord,
    merchantId: MerchantId,
  ): Promise<SkillIntentResult> {
    this.#managementUrl();
    const assistantId = await this.#generationCoordinator.generate(session, merchantId);
    return this.#toResult({
      ...session,
      assistantId,
      snapshot: transitionOnboarding(session.snapshot, {
        type: 'generation_succeeded',
        assistantId,
      }),
      version: session.version + 1,
    });
  }

  async #toResult(session: OnboardingSessionRecord): Promise<SkillIntentResult> {
    const industryCode = session.snapshot.answers.industryCode;
    let guides: readonly IndustryTemplateGuide[] | undefined;
    if (
      this.#industryGuides &&
      (session.snapshot.state === 'industry' ||
        session.snapshot.state === 'materials' ||
        session.snapshot.state === 'policy')
    ) {
      try {
        guides = await this.#industryGuides.listActive();
      } catch {
        guides = undefined;
      }
    }
    const selectedGuide = guides?.find((guide) => guide.code === industryCode);
    return {
      action: 'continue_onboarding',
      onboarding_session_id: session.id,
      state: session.snapshot.state,
      missing_items: [...getOnboardingMissingItems(session.snapshot)],
      ...(session.snapshot.state === 'industry' && guides
        ? {
            industry_options: guides.map((guide) => ({
              code: guide.code,
              display_name: guide.displayName,
              version: guide.version,
            })),
          }
        : {}),
      ...(selectedGuide
        ? {
            industry_guide: {
              code: selectedGuide.code,
              display_name: selectedGuide.displayName,
              version: selectedGuide.version,
              reference_notes: selectedGuide.referenceNotes,
              required_materials: [...selectedGuide.requiredMaterials],
              required_policies: [...selectedGuide.requiredPolicies],
            },
          }
        : {}),
    };
  }

  #existingAssistantsResult(
    merchantId: MerchantId,
    assistants: Awaited<ReturnType<OnboardingRepository['listAssistants']>>,
    selectedRef?: string,
  ): SkillIntentResult {
    if (selectedRef !== undefined || assistants.length === 1) {
      const assistant =
        selectedRef === undefined
          ? assistants[0]
          : assistants.find((candidate) => candidate.id === selectedRef);
      if (selectedRef !== undefined && assistant === undefined)
        throw new AssistantSelectionNotFoundError();
      if (assistant === undefined) throw new Error('Assistant list invariant failed');
      return {
        action: 'open_management_console',
        url: this.#managementUrl(`/workspace/${merchantId}/assistants/${assistant.id}`),
        assistant: {
          assistant_ref: assistant.id,
          display_name: assistant.displayName,
          status: assistant.status,
        },
      };
    }
    return {
      action: 'select_assistant',
      url: this.#managementUrl(`/workspace/${merchantId}`),
      selection_required: true,
      assistants: assistants.map((assistant) => ({
        assistant_ref: assistant.id,
        display_name: assistant.displayName,
        status: assistant.status,
      })),
    };
  }

  #managementUrl(path = '/'): string {
    if (this.#managementConsoleUrl === undefined) {
      throw new ManagementConsoleUnavailableError();
    }
    try {
      const url = new URL(this.#managementConsoleUrl);
      const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      ) {
        throw new ManagementConsoleUnavailableError();
      }
      return new URL(path, url.origin).toString();
    } catch {
      throw new ManagementConsoleUnavailableError();
    }
  }
}
