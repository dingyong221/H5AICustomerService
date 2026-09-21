import { HttpException, HttpStatus } from '@nestjs/common';

import type { ErrorCode } from '@h5cs/contracts';
import { OnboardingOptimisticLockError, OnboardingPersistenceError } from '@h5cs/database';
import {
  InvalidOnboardingTransitionError,
  MerchantSelectionRequiredError,
  OnboardingMissingItemsError,
} from '@h5cs/domain';

import {
  ManagementConsoleUnavailableError,
  MerchantBindingRequiredError,
  OnboardingSessionNotFoundError,
} from './skill-onboarding.service.js';
import {
  WorkBuddyAuthenticationRequiredError,
  WorkBuddyAuthenticationUnavailableError,
} from './workbuddy-authenticator.js';
import { GenerationUnavailableError } from './generation-coordinator.js';

type SafeErrorBody = Readonly<{
  code: ErrorCode;
  message: string;
  retryable: boolean;
}>;

export const safeSkillHttpException = (error: unknown): HttpException | undefined => {
  if (error instanceof HttpException) return error;

  if (error instanceof WorkBuddyAuthenticationRequiredError) {
    return new HttpException(
      safeBody('UNAUTHORIZED', 'Authentication is required', false),
      HttpStatus.UNAUTHORIZED,
    );
  }

  if (
    error instanceof WorkBuddyAuthenticationUnavailableError ||
    error instanceof ManagementConsoleUnavailableError
  ) {
    return new HttpException(
      safeBody('SERVICE_UNAVAILABLE', 'Service is temporarily unavailable', true),
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  if (error instanceof GenerationUnavailableError) {
    return new HttpException(
      safeBody('GENERATION_UNAVAILABLE', 'Assistant generation is temporarily unavailable', true),
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  if (error instanceof OnboardingPersistenceError) {
    return new HttpException(
      safeBody('DATABASE_UNAVAILABLE', 'Service is temporarily unavailable', true),
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  if (error instanceof MerchantBindingRequiredError) {
    return new HttpException(
      safeBody('BINDING_REQUIRED', 'A verified merchant binding is required', false),
      HttpStatus.CONFLICT,
    );
  }

  if (error instanceof OnboardingSessionNotFoundError) {
    return new HttpException(
      safeBody('NOT_FOUND', 'Requested resource is unavailable', false),
      HttpStatus.NOT_FOUND,
    );
  }

  if (error instanceof MerchantSelectionRequiredError) {
    return new HttpException(
      safeBody('MERCHANT_SELECTION_REQUIRED', 'Secure merchant selection is required', false),
      HttpStatus.CONFLICT,
    );
  }

  if (
    error instanceof InvalidOnboardingTransitionError ||
    error instanceof OnboardingMissingItemsError
  ) {
    return new HttpException(
      safeBody('CONFLICT', 'Onboarding state conflict', false),
      HttpStatus.CONFLICT,
    );
  }

  if (error instanceof OnboardingOptimisticLockError) {
    return new HttpException(
      safeBody('VERSION_CONFLICT', 'Onboarding session changed; refresh and retry', true),
      HttpStatus.CONFLICT,
    );
  }

  return undefined;
};

export const safeRequestException = (
  code: 'BAD_REQUEST' | 'UNAUTHORIZED',
  message: string,
): HttpException =>
  new HttpException(
    safeBody(code, message, false),
    code === 'UNAUTHORIZED' ? HttpStatus.UNAUTHORIZED : HttpStatus.BAD_REQUEST,
  );

const safeBody = (code: ErrorCode, message: string, retryable: boolean): SafeErrorBody => ({
  code,
  message,
  retryable,
});
