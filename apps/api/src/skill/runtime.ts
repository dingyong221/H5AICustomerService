import {
  loadDatabaseConfig,
  MySqlOnboardingRepository,
  UnavailableOnboardingRepository,
} from '@h5cs/database';

import { SkillOnboardingApplicationService } from './skill-onboarding.service.js';
import { UnavailableGenerationCoordinator } from './generation-coordinator.js';
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

  return new SkillOnboardingApplicationService(
    authenticator,
    repository,
    new UnavailableGenerationCoordinator(),
    environment['MANAGEMENT_CONSOLE_URL'],
  );
};
