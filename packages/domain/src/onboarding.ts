export const onboardingStates = [
  'industry',
  'materials',
  'policy',
  'confirmation',
  'generating',
  'manageable',
  'cancelled',
] as const;

export type OnboardingState = (typeof onboardingStates)[number];
export type ResumableOnboardingState = Exclude<OnboardingState, 'cancelled' | 'manageable'>;

import type { AssistantId } from './ids.js';

export type OfferingKind = 'product' | 'goods' | 'service';
export type FactAvailability = 'provided' | 'none_confirmed' | 'unknown';
export type InsufficientFactPolicy = 'say_unconfirmed' | 'collect_lead' | 'contact_merchant';

export type Offering = Readonly<{
  kind: OfferingKind;
  name: string;
  description: string;
  targetAudience: string;
}>;

export type MaterialReference = Readonly<{
  kind: 'faq' | 'text' | 'pdf' | 'other';
  reference: string;
  summary: string;
}>;

export type PriceFact = Readonly<{
  offeringName: string;
  amount: string;
  currency: string;
  conditions?: string | undefined;
  effectiveFrom?: string | undefined;
  effectiveUntil?: string | undefined;
}>;

export type PromotionFact = Readonly<{
  name: string;
  description: string;
  conditions?: string | undefined;
  effectiveFrom?: string | undefined;
  effectiveUntil?: string | undefined;
}>;

export type PricingPolicy = Readonly<{
  availability: FactAvailability;
  facts: readonly PriceFact[];
}>;

export type PromotionPolicy = Readonly<{
  availability: FactAvailability;
  facts: readonly PromotionFact[];
}>;

export type OnboardingAnswers = Readonly<{
  industryCode?: string;
  businessName?: string;
  businessDescription?: string;
  offerings?: readonly Offering[];
  materials?: readonly MaterialReference[];
  pricingPolicy?: PricingPolicy;
  promotionPolicy?: PromotionPolicy;
  insufficientFactPolicy?: InsufficientFactPolicy;
  merchantConfirmed?: boolean;
}>;

export type MissingItemCode =
  | 'industry_code'
  | 'business_name'
  | 'business_description'
  | 'offering'
  | 'material_reference'
  | 'pricing_policy'
  | 'promotion_policy'
  | 'insufficient_fact_policy'
  | 'merchant_confirmation';

export type OnboardingMissingItem = Readonly<{
  code: MissingItemCode;
  message: string;
}>;

export type OnboardingSnapshot = Readonly<{
  state: OnboardingState;
  answers: OnboardingAnswers;
  cancelledFrom?: ResumableOnboardingState | undefined;
  generationErrorCode?: string | undefined;
  generatedAssistantId?: AssistantId | undefined;
}>;

export type OnboardingEvent =
  | Readonly<{ type: 'provide_industry'; industryCode: string }>
  | Readonly<{
      type: 'provide_materials';
      businessName?: string;
      businessDescription?: string;
      offerings?: readonly Offering[];
      materials?: readonly MaterialReference[];
    }>
  | Readonly<{
      type: 'provide_policy';
      pricingPolicy?: PricingPolicy;
      promotionPolicy?: PromotionPolicy;
      insufficientFactPolicy?: InsufficientFactPolicy;
    }>
  | Readonly<{ type: 'confirm' }>
  | Readonly<{ type: 'generation_succeeded'; assistantId: AssistantId }>
  | Readonly<{ type: 'generation_failed'; errorCode: string }>
  | Readonly<{ type: 'cancel' }>
  | Readonly<{ type: 'resume' }>;

const messages: Readonly<Record<MissingItemCode, string>> = {
  industry_code: '请选择所属行业。',
  business_name: '请提供商家或业务名称。',
  business_description: '请提供业务范围和服务对象说明。',
  offering: '请至少提供一项产品、商品或服务，并说明名称、内容和适用对象。',
  material_reference: '请提供至少一项可追溯的资料引用和摘要。',
  pricing_policy: '请确认价格信息如何处理，不能由模型自行编造。',
  promotion_policy: '请确认优惠信息如何处理，不能由模型自行编造。',
  insufficient_fact_policy: '请确认资料不足时的处理方式。',
  merchant_confirmation: '请确认以上资料后再开始生成。',
};

const hasText = (value: string | undefined): boolean =>
  value !== undefined && value.trim().length > 0;

const hasValidOffering = (offerings: readonly Offering[] | undefined): boolean =>
  offerings?.some(
    (offering) =>
      hasText(offering.name) && hasText(offering.description) && hasText(offering.targetAudience),
  ) === true;

const hasValidMaterial = (materials: readonly MaterialReference[] | undefined): boolean =>
  materials?.some((material) => hasText(material.reference) && hasText(material.summary)) === true;

const hasValidPricingPolicy = (policy: PricingPolicy | undefined): boolean =>
  policy !== undefined &&
  (policy.availability !== 'provided' ||
    policy.facts.some(
      (fact) => hasText(fact.offeringName) && hasText(fact.amount) && hasText(fact.currency),
    ));

const hasValidPromotionPolicy = (policy: PromotionPolicy | undefined): boolean =>
  policy !== undefined &&
  (policy.availability !== 'provided' ||
    policy.facts.some((fact) => hasText(fact.name) && hasText(fact.description)));

export const getOnboardingMissingItems = (
  snapshot: OnboardingSnapshot,
): readonly OnboardingMissingItem[] => {
  if (
    snapshot.state === 'cancelled' ||
    snapshot.state === 'generating' ||
    snapshot.state === 'manageable'
  ) {
    return [];
  }

  const missing: MissingItemCode[] = [];
  const answers = snapshot.answers;
  if (!hasText(answers.industryCode)) missing.push('industry_code');
  if (!hasText(answers.businessName)) missing.push('business_name');
  if (!hasText(answers.businessDescription)) missing.push('business_description');
  if (!hasValidOffering(answers.offerings)) missing.push('offering');
  if (!hasValidMaterial(answers.materials)) missing.push('material_reference');
  if (!hasValidPricingPolicy(answers.pricingPolicy)) missing.push('pricing_policy');
  if (!hasValidPromotionPolicy(answers.promotionPolicy)) missing.push('promotion_policy');
  if (answers.insufficientFactPolicy === undefined) missing.push('insufficient_fact_policy');
  if (snapshot.state === 'confirmation' && answers.merchantConfirmed !== true) {
    missing.push('merchant_confirmation');
  }

  return missing.map((code) => ({ code, message: messages[code] }));
};

export const createOnboardingSnapshot = (): OnboardingSnapshot => ({
  state: 'industry',
  answers: {},
});

export class InvalidOnboardingTransitionError extends Error {
  public constructor(state: OnboardingState, event: OnboardingEvent['type']) {
    super(`Onboarding event ${event} is not allowed in state ${state}`);
    this.name = 'InvalidOnboardingTransitionError';
  }
}

export class OnboardingMissingItemsError extends Error {
  public readonly missingItems: readonly OnboardingMissingItem[];

  public constructor(missingItems: readonly OnboardingMissingItem[]) {
    super('Onboarding has required items that are still missing');
    this.name = 'OnboardingMissingItemsError';
    this.missingItems = missingItems;
  }
}

const requireState = (
  snapshot: OnboardingSnapshot,
  event: OnboardingEvent['type'],
  expected: OnboardingState,
): void => {
  if (snapshot.state !== expected)
    throw new InvalidOnboardingTransitionError(snapshot.state, event);
};

const requireOneOfStates = (
  snapshot: OnboardingSnapshot,
  event: OnboardingEvent['type'],
  expected: readonly OnboardingState[],
): void => {
  if (!expected.includes(snapshot.state)) {
    throw new InvalidOnboardingTransitionError(snapshot.state, event);
  }
};

export const transitionOnboarding = (
  snapshot: OnboardingSnapshot,
  event: OnboardingEvent,
): OnboardingSnapshot => {
  switch (event.type) {
    case 'provide_industry': {
      requireOneOfStates(snapshot, event.type, ['industry', 'materials', 'policy', 'confirmation']);
      const updated: OnboardingSnapshot = {
        ...snapshot,
        state: 'materials',
        answers: {
          ...snapshot.answers,
          industryCode: event.industryCode.trim(),
          merchantConfirmed: false,
        },
      };
      return hasText(updated.answers.industryCode) ? updated : { ...updated, state: 'industry' };
    }
    case 'provide_materials': {
      requireOneOfStates(snapshot, event.type, ['materials', 'policy', 'confirmation']);
      const updated: OnboardingSnapshot = {
        ...snapshot,
        state: 'materials',
        answers: {
          ...snapshot.answers,
          merchantConfirmed: false,
          ...(event.businessName === undefined ? {} : { businessName: event.businessName.trim() }),
          ...(event.businessDescription === undefined
            ? {}
            : { businessDescription: event.businessDescription.trim() }),
          ...(event.offerings === undefined ? {} : { offerings: event.offerings }),
          ...(event.materials === undefined ? {} : { materials: event.materials }),
        },
      };
      const materialMissing = getOnboardingMissingItems(updated).filter((item) =>
        [
          'industry_code',
          'business_name',
          'business_description',
          'offering',
          'material_reference',
        ].includes(item.code),
      );
      return materialMissing.length === 0 ? { ...updated, state: 'policy' } : updated;
    }
    case 'provide_policy': {
      requireOneOfStates(snapshot, event.type, ['policy', 'confirmation']);
      const updated: OnboardingSnapshot = {
        ...snapshot,
        state: 'policy',
        answers: {
          ...snapshot.answers,
          merchantConfirmed: false,
          ...(event.pricingPolicy === undefined ? {} : { pricingPolicy: event.pricingPolicy }),
          ...(event.promotionPolicy === undefined
            ? {}
            : { promotionPolicy: event.promotionPolicy }),
          ...(event.insufficientFactPolicy === undefined
            ? {}
            : { insufficientFactPolicy: event.insufficientFactPolicy }),
        },
      };
      const policyMissing = getOnboardingMissingItems(updated).filter(
        (item) => item.code !== 'merchant_confirmation',
      );
      return policyMissing.length === 0 ? { ...updated, state: 'confirmation' } : updated;
    }
    case 'confirm': {
      requireState(snapshot, event.type, 'confirmation');
      const updated: OnboardingSnapshot = {
        ...snapshot,
        answers: { ...snapshot.answers, merchantConfirmed: true },
        generationErrorCode: undefined,
      };
      const missing = getOnboardingMissingItems(updated);
      if (missing.length > 0) throw new OnboardingMissingItemsError(missing);
      return { ...updated, state: 'generating' };
    }
    case 'generation_succeeded':
      requireState(snapshot, event.type, 'generating');
      return {
        ...snapshot,
        state: 'manageable',
        generationErrorCode: undefined,
        generatedAssistantId: event.assistantId,
      };
    case 'generation_failed':
      requireState(snapshot, event.type, 'generating');
      return {
        ...snapshot,
        state: 'confirmation',
        answers: { ...snapshot.answers, merchantConfirmed: false },
        generationErrorCode: event.errorCode,
      };
    case 'cancel': {
      if (snapshot.state === 'cancelled' || snapshot.state === 'manageable') {
        throw new InvalidOnboardingTransitionError(snapshot.state, event.type);
      }
      const cancelledFrom = snapshot.state === 'generating' ? 'confirmation' : snapshot.state;
      return {
        ...snapshot,
        state: 'cancelled',
        cancelledFrom,
        answers:
          snapshot.state === 'generating'
            ? { ...snapshot.answers, merchantConfirmed: false }
            : snapshot.answers,
      };
    }
    case 'resume':
      requireState(snapshot, event.type, 'cancelled');
      if (snapshot.cancelledFrom === undefined) {
        throw new InvalidOnboardingTransitionError(snapshot.state, event.type);
      }
      return { ...snapshot, state: snapshot.cancelledFrom, cancelledFrom: undefined };
  }
};
