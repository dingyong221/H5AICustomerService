import { Body, Controller, Headers, HttpCode, Param, Post } from '@nestjs/common';

import {
  onboardingEventRequestSchema,
  onboardingSessionIdSchema,
  skillIntentRequestSchema,
} from '@h5cs/contracts';
import type { OnboardingEventRequest } from '@h5cs/contracts';
import type { OnboardingEvent } from '@h5cs/domain';

import { safeRequestException, safeSkillHttpException } from './skill-http-error.js';
import { SkillOnboardingApplicationService } from './skill-onboarding.service.js';

const bearerHeaderPattern = /^Bearer [^\s]{1,4096}$/u;

type ExternalOnboardingEvent = Exclude<
  OnboardingEvent,
  Readonly<{ type: 'generation_succeeded' | 'generation_failed' }>
>;

const toDomainEvent = (event: OnboardingEventRequest['event']): ExternalOnboardingEvent => {
  switch (event.type) {
    case 'provide_materials':
      return {
        type: event.type,
        ...(event.businessName === undefined ? {} : { businessName: event.businessName }),
        ...(event.businessDescription === undefined
          ? {}
          : { businessDescription: event.businessDescription }),
        ...(event.offerings === undefined ? {} : { offerings: event.offerings }),
        ...(event.materials === undefined ? {} : { materials: event.materials }),
      };
    case 'provide_policy':
      return {
        type: event.type,
        ...(event.pricingPolicy === undefined ? {} : { pricingPolicy: event.pricingPolicy }),
        ...(event.promotionPolicy === undefined ? {} : { promotionPolicy: event.promotionPolicy }),
        ...(event.insufficientFactPolicy === undefined
          ? {}
          : { insufficientFactPolicy: event.insufficientFactPolicy }),
      };
    default:
      return event;
  }
};

@Controller('/api/v1/skill')
export class SkillController {
  public constructor(private readonly service: SkillOnboardingApplicationService) {}

  @Post('/intents')
  @HttpCode(200)
  public async executeIntent(
    @Headers('authorization') authorizationHeader: string | undefined,
    @Body() body: unknown,
  ) {
    const request = skillIntentRequestSchema.safeParse(body);
    if (!request.success) {
      throw safeRequestException('BAD_REQUEST', 'Invalid Skill intent request');
    }

    if (authorizationHeader !== undefined && !bearerHeaderPattern.test(authorizationHeader)) {
      throw safeRequestException('UNAUTHORIZED', 'Authentication is required');
    }
    if (request.data.intent !== 'help' && authorizationHeader === undefined) {
      throw safeRequestException('UNAUTHORIZED', 'Authentication is required');
    }

    try {
      return await this.service.execute(authorizationHeader, request.data);
    } catch (error) {
      throw safeSkillHttpException(error) ?? error;
    }
  }

  @Post('/onboarding/:sessionId/events')
  @HttpCode(200)
  public async advanceOnboarding(
    @Headers('authorization') authorizationHeader: string | undefined,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
  ) {
    if (authorizationHeader === undefined || !bearerHeaderPattern.test(authorizationHeader)) {
      throw safeRequestException('UNAUTHORIZED', 'Authentication is required');
    }

    const parsedSessionId = onboardingSessionIdSchema.safeParse(sessionId);
    if (!parsedSessionId.success) {
      throw safeRequestException('BAD_REQUEST', 'Invalid onboarding session ID');
    }

    const request = onboardingEventRequestSchema.safeParse(body);
    if (!request.success) {
      throw safeRequestException('BAD_REQUEST', 'Invalid onboarding event request');
    }

    try {
      return await this.service.advance({
        authorizationHeader,
        sessionId: parsedSessionId.data,
        event: toDomainEvent(request.data.event),
      });
    } catch (error) {
      throw safeSkillHttpException(error) ?? error;
    }
  }
}
