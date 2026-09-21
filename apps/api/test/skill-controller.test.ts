import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { OnboardingOptimisticLockError, OnboardingPersistenceError } from '@h5cs/database';
import {
  InvalidOnboardingTransitionError,
  MerchantSelectionRequiredError,
  createOnboardingSnapshot,
} from '@h5cs/domain';

import { SkillController } from '../src/skill/skill.controller.js';
import { GenerationUnavailableError } from '../src/skill/generation-coordinator.js';
import {
  MerchantBindingRequiredError,
  OnboardingSessionNotFoundError,
  SkillOnboardingApplicationService,
} from '../src/skill/skill-onboarding.service.js';
import { WorkBuddyAuthenticationUnavailableError } from '../src/skill/workbuddy-authenticator.js';

type ServiceMethods = Pick<SkillOnboardingApplicationService, 'execute' | 'advance'>;

const controllerWith = (methods: ServiceMethods): SkillController =>
  new SkillController(methods as SkillOnboardingApplicationService);

const expectHttpError = async (
  operation: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
): Promise<void> => {
  try {
    await operation;
    throw new Error('Expected an HTTP exception');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toMatchObject({
      code,
      ...(message === undefined ? {} : { message }),
    });
  }
};

describe('Skill HTTP controller', () => {
  it('keeps help public while requiring a strict Bearer header for protected intents', async () => {
    const controller = controllerWith({
      execute: async () => ({
        action: 'help',
        supported_intents: ['create_customer_service', 'open_management_console'],
      }),
      advance: async () => {
        throw new Error('not used');
      },
    });

    await expect(controller.executeIntent(undefined, { intent: 'help' })).resolves.toMatchObject({
      action: 'help',
    });
    await expectHttpError(
      controller.executeIntent(undefined, { intent: 'create_customer_service' }),
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
    );
    await expectHttpError(
      controller.executeIntent('Basic token', { intent: 'help' }),
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
    );
  });

  it('rejects malformed bodies, session IDs, internal events, and identity injection', async () => {
    const controller = controllerWith({
      execute: async () => {
        throw new Error('must not reach service');
      },
      advance: async () => {
        throw new Error('must not reach service');
      },
    });

    await expectHttpError(
      controller.executeIntent(undefined, { intent: 'help', open_id: 'raw-subject' }),
      HttpStatus.BAD_REQUEST,
      'BAD_REQUEST',
    );
    await expectHttpError(
      controller.advanceOnboarding('Bearer token', 'not-a-session', { event: { type: 'confirm' } }),
      HttpStatus.BAD_REQUEST,
      'BAD_REQUEST',
    );
    await expectHttpError(
      controller.advanceOnboarding('Bearer token', '3'.repeat(32), {
        event: { type: 'generation_succeeded', assistantId: 'caller-controlled' },
      }),
      HttpStatus.BAD_REQUEST,
      'BAD_REQUEST',
    );
  });

  it('passes a valid structured merchant event to the application service', async () => {
    let receivedEvent: unknown;
    const controller = controllerWith({
      execute: async () => {
        throw new Error('not used');
      },
      advance: async (command) => {
        receivedEvent = command.event;
        return {
          action: 'continue_onboarding',
          onboarding_session_id: '3'.repeat(32),
          state: 'materials',
          missing_items: [],
        };
      },
    });

    await controller.advanceOnboarding('Bearer token', '3'.repeat(32), {
      event: { type: 'provide_industry', industryCode: 'retail' },
    });
    expect(receivedEvent).toEqual({ type: 'provide_industry', industryCode: 'retail' });
  });

  it('maps unconfigured dependencies and persistence failures without leaking details', async () => {
    const unavailable = controllerWith({
      execute: async () => {
        throw new WorkBuddyAuthenticationUnavailableError('internal OAuth configuration');
      },
      advance: async () => {
        throw new OnboardingPersistenceError('private database host');
      },
    });

    await expectHttpError(
      unavailable.executeIntent('Bearer token', { intent: 'create_customer_service' }),
      HttpStatus.SERVICE_UNAVAILABLE,
      'SERVICE_UNAVAILABLE',
      'Service is temporarily unavailable',
    );
    await expectHttpError(
      unavailable.advanceOnboarding('Bearer token', '3'.repeat(32), {
        event: { type: 'confirm' },
      }),
      HttpStatus.SERVICE_UNAVAILABLE,
      'DATABASE_UNAVAILABLE',
      'Service is temporarily unavailable',
    );
  });

  it('reports generation unavailability without entering a fake running state', async () => {
    const controller = controllerWith({
      execute: async () => {
        throw new Error('not used');
      },
      advance: async () => {
        throw new GenerationUnavailableError('private dispatcher details');
      },
    });

    await expectHttpError(
      controller.advanceOnboarding('Bearer token', '3'.repeat(32), {
        event: { type: 'confirm' },
      }),
      HttpStatus.SERVICE_UNAVAILABLE,
      'GENERATION_UNAVAILABLE',
      'Assistant generation is temporarily unavailable',
    );
  });

  it('distinguishes binding required from a missing session without leaking identifiers', async () => {
    const binding = controllerWith({
      execute: async () => {
        throw new MerchantBindingRequiredError();
      },
      advance: async () => {
        throw new Error('not used');
      },
    });
    await expectHttpError(
      binding.executeIntent('Bearer token', { intent: 'open_management_console' }),
      HttpStatus.CONFLICT,
      'BINDING_REQUIRED',
      'A verified merchant binding is required',
    );

    const missingSession = controllerWith({
      execute: async () => {
        throw new Error('not used');
      },
      advance: async () => {
        throw new OnboardingSessionNotFoundError();
      },
    });
    await expectHttpError(
      missingSession.advanceOnboarding('Bearer token', '3'.repeat(32), {
        event: { type: 'confirm' },
      }),
      HttpStatus.NOT_FOUND,
      'NOT_FOUND',
      'Requested resource is unavailable',
    );
  });

  it('keeps optimistic locking distinct from business state conflicts', async () => {
    const controller = controllerWith({
      execute: async () => {
        throw new Error('not used');
      },
      advance: async () => {
        throw new OnboardingOptimisticLockError();
      },
    });

    await expectHttpError(
      controller.advanceOnboarding('Bearer token', '3'.repeat(32), {
        event: { type: 'confirm' },
      }),
      HttpStatus.CONFLICT,
      'VERSION_CONFLICT',
      'Onboarding session changed; refresh and retry',
    );
  });

  it('maps state conflicts and ambiguous merchant membership to stable safe errors', async () => {
    const conflict = controllerWith({
      execute: async () => {
        throw new MerchantSelectionRequiredError();
      },
      advance: async () => {
        throw new InvalidOnboardingTransitionError('generating', 'provide_industry');
      },
    });

    await expectHttpError(
      conflict.executeIntent('Bearer token', { intent: 'open_management_console' }),
      HttpStatus.CONFLICT,
      'MERCHANT_SELECTION_REQUIRED',
      'Secure merchant selection is required',
    );
    await expectHttpError(
      conflict.advanceOnboarding('Bearer token', '3'.repeat(32), {
        event: { type: 'provide_industry', industryCode: 'retail' },
      }),
      HttpStatus.CONFLICT,
      'CONFLICT',
      'Onboarding state conflict',
    );
  });

  it('accepts safe edits at confirmation through the application boundary contract', async () => {
    const snapshot = { ...createOnboardingSnapshot(), state: 'confirmation' as const };
    const controller = controllerWith({
      execute: async () => {
        throw new Error('not used');
      },
      advance: async (command) => ({
        action: 'continue_onboarding',
        onboarding_session_id: '3'.repeat(32),
        state: command.event.type === 'provide_industry' ? 'materials' : snapshot.state,
        missing_items: [],
      }),
    });

    await expect(
      controller.advanceOnboarding('Bearer token', '3'.repeat(32), {
        event: { type: 'provide_industry', industryCode: 'retail' },
      }),
    ).resolves.toMatchObject({ state: 'materials' });
  });
});
