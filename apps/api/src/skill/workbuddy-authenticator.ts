import { createHmac } from 'node:crypto';

import type { VerifiedExternalIdentity } from '@h5cs/domain';

export interface WorkBuddyAuthenticator {
  assertReady(): Promise<void>;
  authenticateAccessToken(authorizationHeader: string): Promise<VerifiedExternalIdentity>;
}

export class WorkBuddyAuthenticationUnavailableError extends Error {
  public constructor(message = 'WorkBuddy authentication is not configured') {
    super(message);
    this.name = 'WorkBuddyAuthenticationUnavailableError';
  }
}

export class WorkBuddyAuthenticationRequiredError extends Error {
  public constructor() {
    super('A verified WorkBuddy access token is required');
    this.name = 'WorkBuddyAuthenticationRequiredError';
  }
}

export class UnavailableWorkBuddyAuthenticator implements WorkBuddyAuthenticator {
  readonly #reason: string;

  public constructor(reason = 'WorkBuddy OAuth verification is not configured') {
    this.#reason = reason;
  }

  public async assertReady(): Promise<void> {
    await Promise.resolve();
    throw new WorkBuddyAuthenticationUnavailableError(this.#reason);
  }

  public async authenticateAccessToken(): Promise<never> {
    await Promise.resolve();
    throw new WorkBuddyAuthenticationUnavailableError(this.#reason);
  }
}

export type ExternalSubjectContext = Readonly<{
  issuer: string;
  clientId: string;
  openId: string;
  lookupKeyVersion: number;
}>;

export const deriveExternalSubjectLookupKey = (
  context: ExternalSubjectContext,
  hmacSecret: Uint8Array,
): Uint8Array => {
  if (hmacSecret.byteLength < 32) {
    throw new WorkBuddyAuthenticationUnavailableError(
      'WorkBuddy subject HMAC secret must contain at least 32 bytes',
    );
  }
  if (
    context.issuer.trim().length === 0 ||
    context.clientId.trim().length === 0 ||
    context.openId.length === 0 ||
    !Number.isSafeInteger(context.lookupKeyVersion) ||
    context.lookupKeyVersion < 1
  ) {
    throw new WorkBuddyAuthenticationRequiredError();
  }

  const hmac = createHmac('sha256', hmacSecret);
  const updateLengthPrefixed = (value: string): void => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hmac.update(length).update(bytes);
  };

  updateLengthPrefixed(context.issuer);
  updateLengthPrefixed(context.clientId);
  updateLengthPrefixed(context.openId);
  // lookupKeyVersion identifies the server-side HMAC key and is persisted beside the digest.
  // Reading old versions while writing a new version is intentionally not implemented yet.
  return hmac.digest();
};
