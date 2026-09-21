import { loadWorkBuddyOpenApiClient } from './workbuddy-open-api-client.js';
import {
  UnavailableWorkBuddyLocalAuthorizationService,
  type WorkBuddyLocalAuthorizationService,
} from './workbuddy-local-authorization.service.js';

export const createRuntimeWorkBuddyLocalAuthorization = (
  environment: NodeJS.ProcessEnv = process.env,
): WorkBuddyLocalAuthorizationService => {
  const client = loadWorkBuddyOpenApiClient(environment);
  if (!client.configured) {
    return new UnavailableWorkBuddyLocalAuthorizationService(client.reason);
  }

  // The WorkBuddy client alone is not sufficient. Until platform login, bridge-state persistence,
  // local authorization transactions, consent and merchant-candidate adapters are all wired, the
  // API must remain unavailable instead of inventing a process-local account or binding.
  return new UnavailableWorkBuddyLocalAuthorizationService(
    'Platform login and local authorization persistence adapters are not configured',
  );
};
