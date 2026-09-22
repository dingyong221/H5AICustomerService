import type {
  ConnectorAuthorizationRepository,
  ConnectorBindingResolution,
  VerifiedExternalIdentity,
} from '@h5cs/domain';

import {
  OAuthAccessTokenInvalidError,
  OAuthIdentityBindingUnavailableError,
} from './oauth-errors.js';
import type { OAuthAuthorizationContext, OAuthIdentityBindingResolver } from './oauth-types.js';

type BindingRepository = Pick<ConnectorAuthorizationRepository, 'resolveActiveBinding'> &
  Readonly<{ assertReady(): Promise<void> }>;

const opaqueBindingPattern = /^[A-Za-z0-9](?:[A-Za-z0-9:_-]{0,190})$/u;
const hexIdPattern = /^[0-9a-f]{32}$/u;

const validIdentity = (identity: VerifiedExternalIdentity): boolean =>
  identity.provider === 'workbuddy' &&
  identity.issuer.length > 0 &&
  identity.issuer.length <= 2_048 &&
  identity.audience.length > 0 &&
  identity.audience.length <= 512 &&
  identity.subjectLookupKey.byteLength === 32 &&
  Number.isSafeInteger(identity.subjectLookupKeyVersion) &&
  identity.subjectLookupKeyVersion >= 1 &&
  Number.isFinite(identity.verifiedAt.getTime()) &&
  (identity.phoneMatchVerifiedAt === null ||
    Number.isFinite(identity.phoneMatchVerifiedAt.getTime()));

const validResolution = (
  resolution: ConnectorBindingResolution,
  bindingId: string,
  context: OAuthAuthorizationContext,
): boolean =>
  resolution.bindingId === bindingId &&
  resolution.clientId === context.clientId &&
  resolution.resource === context.resource &&
  context.scope === 'mcp:tools' &&
  resolution.scope === context.scope &&
  opaqueBindingPattern.test(resolution.grantId) &&
  hexIdPattern.test(resolution.merchantUserId) &&
  hexIdPattern.test(resolution.externalIdentityId) &&
  hexIdPattern.test(resolution.merchantId) &&
  validIdentity(resolution.identity);

export class RepositoryOAuthIdentityBindingResolver implements OAuthIdentityBindingResolver {
  readonly #repository: BindingRepository;
  readonly #clock: () => Date;

  public constructor(repository: BindingRepository, clock: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#clock = clock;
  }

  public async assertReady(): Promise<void> {
    try {
      await this.#repository.assertReady();
    } catch {
      throw new OAuthIdentityBindingUnavailableError();
    }
  }

  public async resolve(
    bindingId: string,
    context: OAuthAuthorizationContext,
  ): Promise<VerifiedExternalIdentity> {
    if (!opaqueBindingPattern.test(bindingId) || context.scope !== 'mcp:tools') {
      throw new OAuthAccessTokenInvalidError();
    }

    let resolution: ConnectorBindingResolution | null;
    try {
      resolution = await this.#repository.resolveActiveBinding(bindingId, this.#clock());
    } catch {
      throw new OAuthIdentityBindingUnavailableError();
    }
    let valid = false;
    try {
      valid = resolution !== null && validResolution(resolution, bindingId, context);
    } catch {
      valid = false;
    }
    if (!valid || resolution === null) {
      throw new OAuthAccessTokenInvalidError();
    }
    return resolution.identity;
  }
}
