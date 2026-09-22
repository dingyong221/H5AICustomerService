declare const brand: unique symbol;

export type Brand<TValue, TName extends string> = TValue & {
  readonly [brand]: TName;
};

export type MerchantId = Brand<string, 'MerchantId'>;
export type AssistantId = Brand<string, 'AssistantId'>;
export type ReleaseId = Brand<string, 'ReleaseId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type MerchantUserId = Brand<string, 'MerchantUserId'>;
export type ExternalIdentityId = Brand<string, 'ExternalIdentityId'>;
export type OnboardingSessionId = Brand<string, 'OnboardingSessionId'>;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class InvalidDomainIdError extends Error {
  public constructor(kind: string) {
    super(`Invalid ${kind}`);
    this.name = 'InvalidDomainIdError';
  }
}

const toId = <TId extends string>(kind: string, value: string): TId => {
  if (!idPattern.test(value)) {
    throw new InvalidDomainIdError(kind);
  }

  return value as TId;
};

export const toMerchantId = (value: string): MerchantId => toId<MerchantId>('MerchantId', value);
export const toAssistantId = (value: string): AssistantId =>
  toId<AssistantId>('AssistantId', value);
export const toReleaseId = (value: string): ReleaseId => toId<ReleaseId>('ReleaseId', value);
export const toSessionId = (value: string): SessionId => toId<SessionId>('SessionId', value);
export const toTurnId = (value: string): TurnId => toId<TurnId>('TurnId', value);
export const toMessageId = (value: string): MessageId => toId<MessageId>('MessageId', value);
export const toMerchantUserId = (value: string): MerchantUserId =>
  toId<MerchantUserId>('MerchantUserId', value);
export const toExternalIdentityId = (value: string): ExternalIdentityId =>
  toId<ExternalIdentityId>('ExternalIdentityId', value);
export const toOnboardingSessionId = (value: string): OnboardingSessionId =>
  toId<OnboardingSessionId>('OnboardingSessionId', value);
