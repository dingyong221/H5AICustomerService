import {
  loadDatabaseConfig,
  MySqlIdentityAuthorizationRepository,
  MySqlPlatformLoginSessionRepository,
} from '@h5cs/database';

import { RepositoryOAuthIdentityBindingResolver } from './oauth-identity-binding-resolver.js';
import {
  RepositoryPlatformLoginService,
  type PlatformLoginServiceConfig,
} from './platform-login-service.js';

export type ProductionOAuthAdapters =
  | Readonly<{
      configured: true;
      identityBindings: RepositoryOAuthIdentityBindingResolver;
      platformLogin: RepositoryPlatformLoginService;
    }>
  | Readonly<{
      configured: false;
      reason: 'OAuth production security adapters are not fully configured';
    }>;

const unavailable = (): ProductionOAuthAdapters => ({
  configured: false,
  reason: 'OAuth production security adapters are not fully configured',
});

const loadPlatformLoginConfig = (
  environment: NodeJS.ProcessEnv,
): PlatformLoginServiceConfig | null => {
  const cookieName = environment['PLATFORM_LOGIN_SESSION_COOKIE_NAME'];
  const configuredOrigins = environment['PLATFORM_LOGIN_ALLOWED_ORIGINS'];
  if (cookieName === undefined || configuredOrigins === undefined) return null;
  const allowedOrigins = configuredOrigins.split(',').map((origin) => origin.trim());
  if (allowedOrigins.some((origin) => origin.length === 0)) return null;
  return {
    cookieName,
    allowedOrigins,
    production: environment['NODE_ENV'] === 'production',
  };
};

export const loadProductionOAuthAdapters = (
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
): ProductionOAuthAdapters => {
  try {
    const database = loadDatabaseConfig(environment);
    const platformLoginConfig = loadPlatformLoginConfig(environment);
    if (!database.configured || platformLoginConfig === null) return unavailable();

    const identityRepository = new MySqlIdentityAuthorizationRepository(database.config);
    const platformLoginRepository = new MySqlPlatformLoginSessionRepository(database.config);
    return {
      configured: true,
      identityBindings: new RepositoryOAuthIdentityBindingResolver(identityRepository, clock),
      platformLogin: new RepositoryPlatformLoginService(
        platformLoginRepository,
        platformLoginConfig,
        clock,
      ),
    };
  } catch {
    return unavailable();
  }
};
