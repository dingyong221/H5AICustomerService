import type {
  OnboardingApiClient,
  OnboardingEventPayload,
  OnboardingStartResult,
} from './onboarding-api-client';
import { buildEventForStep, type OnboardingFormValues } from './onboarding-form-model';

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
}: SubmitOnboardingInput): Promise<OnboardingStartResult> {
  let result = await client.startOrResume({ idempotencyKey: createIdempotencyKey() });

  if (result.action !== 'continue_onboarding') return result;

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

  if (result.state === 'manageable') {
    try {
      const management = await client.startOrResume({ idempotencyKey: createIdempotencyKey() });
      if (management.action !== 'continue_onboarding') return management;
    } catch {
      // The draft is already committed; keep the confirmed result and offer a separate link retry.
    }
  }

  return result;
}
