import {
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlIndustryTemplateRepository,
  MySqlOnboardingRepository,
  UnavailableOnboardingRepository,
} from '@h5cs/database';

import { SkillOnboardingApplicationService } from './skill-onboarding.service.js';
import {
  ConfirmedFactsGenerationCoordinator,
  UnavailableGenerationCoordinator,
} from './generation-coordinator.js';
import { UnavailableWorkBuddyAuthenticator } from './workbuddy-authenticator.js';
import type { WorkBuddyAuthenticator } from './workbuddy-authenticator.js';

export const createRuntimeSkillOnboardingService = (
  environment: NodeJS.ProcessEnv = process.env,
  authenticator: WorkBuddyAuthenticator = new UnavailableWorkBuddyAuthenticator(),
): SkillOnboardingApplicationService => {
  const database = loadDatabaseConfig(environment);
  const repository = database.configured
    ? new MySqlOnboardingRepository(database.config)
    : new UnavailableOnboardingRepository(database.reason);
  const generation = database.configured
    ? new ConfirmedFactsGenerationCoordinator(
        new MySqlAssistantLifecycleRepository(database.config),
      )
    : new UnavailableGenerationCoordinator(database.reason);

  return new SkillOnboardingApplicationService(
    authenticator,
    repository,
    generation,
    environment['MANAGEMENT_CONSOLE_URL'],
    database.configured ? new MySqlIndustryTemplateRepository(database.config) : undefined,
  );
};
