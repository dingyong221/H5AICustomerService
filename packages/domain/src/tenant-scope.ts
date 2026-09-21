import type { AssistantId, MerchantId } from './ids.js';

export type MerchantScope = Readonly<{
  merchantId: MerchantId;
}>;

export type AssistantScope = Readonly<{
  merchantId: MerchantId;
  assistantId: AssistantId;
}>;

export class TenantScopeMismatchError extends Error {
  public constructor() {
    super('Resource does not belong to the active tenant scope');
    this.name = 'TenantScopeMismatchError';
  }
}

export const assertAssistantScope = (expected: AssistantScope, actual: AssistantScope): void => {
  if (expected.merchantId !== actual.merchantId || expected.assistantId !== actual.assistantId) {
    throw new TenantScopeMismatchError();
  }
};
