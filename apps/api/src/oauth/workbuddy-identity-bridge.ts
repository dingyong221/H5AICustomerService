import { createHash } from 'node:crypto';

import type {
  MerchantUserId,
  VerifiedExternalIdentity,
  WorkBuddyBindingStateRecord,
  WorkBuddyBindingStateRepository as DomainWorkBuddyBindingStateRepository,
  WorkBuddyBindingStateToStore,
} from '@h5cs/domain';

import {
  deriveExternalSubjectLookupKey,
  WorkBuddyAuthenticationRequiredError,
  WorkBuddyAuthenticationUnavailableError,
} from '../skill/workbuddy-authenticator.js';
import type { WorkBuddyOpenApiClient } from './workbuddy-open-api-client.js';

export type { WorkBuddyBindingStateRecord, WorkBuddyBindingStateToStore } from '@h5cs/domain';

export type WorkBuddyBindingStateRepository = Pick<
  DomainWorkBuddyBindingStateRepository,
  'assertReady' | 'consume'
>;

export class UnavailableWorkBuddyBindingStateRepository implements DomainWorkBuddyBindingStateRepository {
  public async assertReady(): Promise<never> {
    await Promise.resolve();
    throw new WorkBuddyAuthenticationUnavailableError(
      'WorkBuddy binding-state persistence is not configured',
    );
  }

  public async consume(
    _stateDigest: Uint8Array,
    _loginSessionDigest: Uint8Array,
    _now: Date,
  ): Promise<never> {
    return this.assertReady();
  }

  public async store(_record: WorkBuddyBindingStateToStore): Promise<never> {
    return this.assertReady();
  }
}

export type WorkBuddyIdentityBridgeResult = Readonly<{
  transactionId: string;
  merchantUserId: MerchantUserId;
  identity: VerifiedExternalIdentity;
  grantedScopes: readonly string[];
  accessTokenExpiresAt: Date;
}>;

const digestState = (state: string): Uint8Array =>
  createHash('sha256').update(state, 'ascii').digest();

const validState = (state: string): boolean => /^[A-Za-z0-9_-]{32,512}$/u.test(state);
const validCode = (code: string): boolean => /^\S{8,2048}$/u.test(code);

export class WorkBuddyIdentityBridge {
  readonly #client: WorkBuddyOpenApiClient;
  readonly #states: WorkBuddyBindingStateRepository;
  readonly #subjectHmacSecret: Uint8Array;
  readonly #subjectLookupKeyVersion: number;
  readonly #configurationId: string;
  readonly #configurationVersion: number;
  readonly #clock: () => Date;

  public constructor(input: {
    client: WorkBuddyOpenApiClient;
    states: WorkBuddyBindingStateRepository;
    subjectHmacSecret: Uint8Array;
    subjectLookupKeyVersion: number;
    configurationId: string;
    configurationVersion: number;
    clock?: () => Date;
  }) {
    if (input.subjectHmacSecret.byteLength < 32) {
      throw new WorkBuddyAuthenticationUnavailableError(
        'WorkBuddy subject HMAC secret must contain at least 32 bytes',
      );
    }
    if (!Number.isSafeInteger(input.subjectLookupKeyVersion) || input.subjectLookupKeyVersion < 1) {
      throw new WorkBuddyAuthenticationUnavailableError(
        'WorkBuddy subject HMAC key version is invalid',
      );
    }
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9:_-]{0,127})$/u.test(input.configurationId) ||
      !Number.isSafeInteger(input.configurationVersion) ||
      input.configurationVersion < 1
    ) {
      throw new WorkBuddyAuthenticationUnavailableError(
        'WorkBuddy authorization configuration identity is invalid',
      );
    }
    this.#client = input.client;
    this.#states = input.states;
    this.#subjectHmacSecret = input.subjectHmacSecret.slice();
    this.#subjectLookupKeyVersion = input.subjectLookupKeyVersion;
    this.#configurationId = input.configurationId;
    this.#configurationVersion = input.configurationVersion;
    this.#clock = input.clock ?? (() => new Date());
  }

  public async completeAuthorization(input: {
    authorizationCode: string;
    loginSessionDigest: Uint8Array;
    state: string;
  }): Promise<WorkBuddyIdentityBridgeResult> {
    if (
      !validState(input.state) ||
      !validCode(input.authorizationCode) ||
      input.loginSessionDigest.byteLength !== 32
    ) {
      throw new WorkBuddyAuthenticationRequiredError();
    }
    await this.#states.assertReady();
    const now = this.#clock();
    const transaction = await this.#states.consume(
      digestState(input.state),
      input.loginSessionDigest,
      now,
    );
    if (
      transaction === null ||
      transaction.expiresAt.getTime() <= now.getTime() ||
      transaction.configurationId !== this.#configurationId ||
      transaction.configurationVersion !== this.#configurationVersion ||
      !Buffer.from(transaction.loginSessionDigest).equals(Buffer.from(input.loginSessionDigest))
    ) {
      throw new WorkBuddyAuthenticationRequiredError();
    }

    // The state is intentionally consumed before the remote exchange. Ambiguous network failures
    // require a new binding attempt rather than replaying an authorization callback.
    const lease = await this.#client.exchangeAuthorizationCode(input.authorizationCode);
    const identity: VerifiedExternalIdentity = {
      provider: 'workbuddy',
      issuer: this.#client.issuer,
      audience: this.#client.clientId,
      subjectLookupKey: deriveExternalSubjectLookupKey(
        {
          issuer: this.#client.issuer,
          clientId: this.#client.clientId,
          openId: lease.openId,
          lookupKeyVersion: this.#subjectLookupKeyVersion,
        },
        this.#subjectHmacSecret,
      ),
      subjectLookupKeyVersion: this.#subjectLookupKeyVersion,
      phoneMatchVerifiedAt: null,
      verifiedAt: now,
    };

    return {
      transactionId: transaction.transactionId,
      merchantUserId: transaction.merchantUserId,
      identity,
      grantedScopes: lease.grantedScopes,
      accessTokenExpiresAt: new Date(now.getTime() + lease.expiresInSeconds * 1_000),
    };
  }
}
