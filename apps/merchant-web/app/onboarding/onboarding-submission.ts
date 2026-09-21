import type { SkillIntentResult } from '@h5cs/contracts';

import type { OnboardingApiClient, OnboardingEventPayload } from './onboarding-api-client';
import { buildEventForStep, type OnboardingFormValues } from './onboarding-form-model';

type ContinueOnboardingResult = Extract<SkillIntentResult, { action: 'continue_onboarding' }>;

interface SubmitOnboardingInput {
  client: OnboardingApiClient;
  createIdempotencyKey: () => string;
  values: OnboardingFormValues;
}

const submissionEvents = (values: OnboardingFormValues): readonly OnboardingEventPayload[] => [
  buildEventForStep('industry', values),
  buildEventForStep('materials', values),
  buildEventForStep('policy', values),
  buildEventForStep('confirmation', values),
];

export async function submitCompleteOnboarding({
  client,
  createIdempotencyKey,
  values,
}: SubmitOnboardingInput): Promise<ContinueOnboardingResult> {
  let result = await client.startOrResume({ idempotencyKey: createIdempotencyKey() });

  if (result.state === 'generating' || result.state === 'manageable') return result;

  if (result.state === 'cancelled') {
    result = await client.advance({
      event: { type: 'resume' },
      idempotencyKey: createIdempotencyKey(),
      sessionId: result.onboarding_session_id,
    });
  }

  for (const event of submissionEvents(values)) {
    result = await client.advance({
      event,
      idempotencyKey: createIdempotencyKey(),
      sessionId: result.onboarding_session_id,
    });
  }

  return result;
}
