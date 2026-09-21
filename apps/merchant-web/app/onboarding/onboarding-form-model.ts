import type { SkillIntentResult } from '@h5cs/contracts';

import type {
  InsufficientFactPolicy,
  OnboardingClientError,
  OnboardingEventPayload,
  PricingAvailability,
} from './onboarding-api-client';

type ContinueOnboardingResult = Extract<SkillIntentResult, { action: 'continue_onboarding' }>;

export type FormStep = 'industry' | 'materials' | 'policy' | 'confirmation';

export interface OnboardingFormValues {
  businessDescription: string;
  businessName: string;
  industryCode: string;
  materialKind: 'faq' | 'text' | 'pdf' | 'other';
  materialReference: string;
  materialSummary: string;
  merchantConfirmed: boolean;
  offeringDescription: string;
  offeringKind: 'product' | 'goods' | 'service';
  offeringName: string;
  offeringTargetAudience: string;
  priceAmount: string;
  priceConditions: string;
  priceCurrency: string;
  pricingAvailability: PricingAvailability | '';
  promotionAvailability: PricingAvailability | '';
  promotionConditions: string;
  promotionDescription: string;
  promotionName: string;
  insufficientFactPolicy: InsufficientFactPolicy | '';
}

export type FormErrors = Partial<Record<keyof OnboardingFormValues, string>>;

export type InteractionStatus =
  | 'editing'
  | 'saving'
  | 'saved'
  | 'generating'
  | 'generated'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'conflict'
  | 'authentication_expired'
  | 'binding_required'
  | 'merchant_selection_required'
  | 'generation_unavailable'
  | 'error';

export interface OnboardingInteractionState {
  notice: string;
  requestId?: string | undefined;
  result?: ContinueOnboardingResult;
  status: InteractionStatus;
}

export type OnboardingInteractionAction =
  | { type: 'edit'; notice?: string }
  | { type: 'request_started'; operation: 'save' | 'pause' | 'resume' }
  | { type: 'server_succeeded'; result: ContinueOnboardingResult }
  | { type: 'request_failed'; error: OnboardingClientError };

export const formSteps: readonly FormStep[] = ['industry', 'materials', 'policy', 'confirmation'];

export const initialOnboardingFormValues: OnboardingFormValues = {
  businessDescription: '',
  businessName: '',
  industryCode: '',
  insufficientFactPolicy: '',
  materialKind: 'text',
  materialReference: '',
  materialSummary: '',
  merchantConfirmed: false,
  offeringDescription: '',
  offeringKind: 'service',
  offeringName: '',
  offeringTargetAudience: '',
  priceAmount: '',
  priceConditions: '',
  priceCurrency: 'CNY',
  pricingAvailability: '',
  promotionAvailability: '',
  promotionConditions: '',
  promotionDescription: '',
  promotionName: '',
};

export const initialOnboardingInteractionState: OnboardingInteractionState = {
  notice: '尚未保存到服务端。',
  status: 'editing',
};

const hasText = (value: string): boolean => value.trim().length > 0;
const exceeds = (value: string, max: number): boolean => value.trim().length > max;
const pricePattern = /^\d+(?:\.\d{1,4})?$/u;
const currencyPattern = /^[A-Z]{3}$/u;

export function validateOnboardingStep(step: FormStep, values: OnboardingFormValues): FormErrors {
  const errors: FormErrors = {};

  if (step === 'industry' && !hasText(values.industryCode)) {
    errors.industryCode = '请选择或填写所属行业。';
  } else if (step === 'industry' && exceeds(values.industryCode, 64)) {
    errors.industryCode = '行业编码不能超过 64 个字符。';
  }

  if (step === 'materials') {
    if (!hasText(values.businessName)) errors.businessName = '请填写商家或业务名称。';
    else if (exceeds(values.businessName, 200)) {
      errors.businessName = '商家或业务名称不能超过 200 个字符。';
    }
    if (!hasText(values.businessDescription)) {
      errors.businessDescription = '请说明业务范围和服务对象。';
    } else if (exceeds(values.businessDescription, 4_000)) {
      errors.businessDescription = '业务说明不能超过 4000 个字符。';
    }
    if (!hasText(values.offeringName)) errors.offeringName = '请填写产品、商品或服务名称。';
    else if (exceeds(values.offeringName, 200)) {
      errors.offeringName = '名称不能超过 200 个字符。';
    }
    if (!hasText(values.offeringDescription)) {
      errors.offeringDescription = '请说明具体提供的内容。';
    } else if (exceeds(values.offeringDescription, 4_000)) {
      errors.offeringDescription = '内容说明不能超过 4000 个字符。';
    }
    if (!hasText(values.offeringTargetAudience)) {
      errors.offeringTargetAudience = '请说明适用对象。';
    } else if (exceeds(values.offeringTargetAudience, 1_000)) {
      errors.offeringTargetAudience = '适用对象不能超过 1000 个字符。';
    }
    if (!hasText(values.materialReference)) {
      errors.materialReference = '请提供可追溯的资料名称或引用。';
    } else if (exceeds(values.materialReference, 1_024)) {
      errors.materialReference = '资料引用不能超过 1024 个字符。';
    }
    if (!hasText(values.materialSummary)) errors.materialSummary = '请填写资料摘要。';
    else if (exceeds(values.materialSummary, 4_000)) {
      errors.materialSummary = '资料摘要不能超过 4000 个字符。';
    }
  }

  if (step === 'policy') {
    if (values.pricingAvailability === '') {
      errors.pricingAvailability = '请确认价格资料状态。';
    } else if (values.pricingAvailability === 'provided') {
      if (!hasText(values.priceAmount)) errors.priceAmount = '请填写价格金额。';
      else if (!pricePattern.test(values.priceAmount.trim())) {
        errors.priceAmount = '价格需为数字，小数最多 4 位。';
      }
      if (!currencyPattern.test(values.priceCurrency.trim())) {
        errors.priceCurrency = '币种必须是 3 位大写字母，例如 CNY。';
      }
      if (exceeds(values.priceConditions, 2_000)) {
        errors.priceConditions = '价格条件不能超过 2000 个字符。';
      }
    }
    if (values.promotionAvailability === '') {
      errors.promotionAvailability = '请确认优惠资料状态。';
    } else if (values.promotionAvailability === 'provided') {
      if (!hasText(values.promotionName)) errors.promotionName = '请填写优惠名称。';
      else if (exceeds(values.promotionName, 200)) {
        errors.promotionName = '优惠名称不能超过 200 个字符。';
      }
      if (!hasText(values.promotionDescription)) {
        errors.promotionDescription = '请填写优惠说明。';
      } else if (exceeds(values.promotionDescription, 4_000)) {
        errors.promotionDescription = '优惠说明不能超过 4000 个字符。';
      }
      if (exceeds(values.promotionConditions, 2_000)) {
        errors.promotionConditions = '优惠条件不能超过 2000 个字符。';
      }
    }
    if (values.insufficientFactPolicy === '') {
      errors.insufficientFactPolicy = '请选择资料不足时的处理方式。';
    }
  }

  if (step === 'confirmation' && !values.merchantConfirmed) {
    errors.merchantConfirmed = '确认资料后才能提交生成。';
  }

  return errors;
}

export function validateAllOnboardingSteps(values: OnboardingFormValues): FormErrors {
  return formSteps.reduce<FormErrors>(
    (allErrors, step) => ({ ...allErrors, ...validateOnboardingStep(step, values) }),
    {},
  );
}

export function buildEventForStep(
  step: FormStep,
  values: OnboardingFormValues,
): OnboardingEventPayload {
  switch (step) {
    case 'industry':
      return { type: 'provide_industry', industryCode: values.industryCode.trim() };
    case 'materials':
      return {
        type: 'provide_materials',
        businessName: values.businessName.trim(),
        businessDescription: values.businessDescription.trim(),
        offerings: [
          {
            kind: values.offeringKind,
            name: values.offeringName.trim(),
            description: values.offeringDescription.trim(),
            targetAudience: values.offeringTargetAudience.trim(),
          },
        ],
        materials: [
          {
            kind: values.materialKind,
            reference: values.materialReference.trim(),
            summary: values.materialSummary.trim(),
          },
        ],
      };
    case 'policy':
      if (
        values.pricingAvailability === '' ||
        values.promotionAvailability === '' ||
        values.insufficientFactPolicy === ''
      ) {
        throw new Error('Policy event cannot be built before validation');
      }
      return {
        type: 'provide_policy',
        pricingPolicy: {
          availability: values.pricingAvailability,
          facts:
            values.pricingAvailability === 'provided'
              ? [
                  {
                    offeringName: values.offeringName.trim(),
                    amount: values.priceAmount.trim(),
                    currency: values.priceCurrency.trim(),
                    ...(hasText(values.priceConditions)
                      ? { conditions: values.priceConditions.trim() }
                      : {}),
                  },
                ]
              : [],
        },
        promotionPolicy: {
          availability: values.promotionAvailability,
          facts:
            values.promotionAvailability === 'provided'
              ? [
                  {
                    name: values.promotionName.trim(),
                    description: values.promotionDescription.trim(),
                    ...(hasText(values.promotionConditions)
                      ? { conditions: values.promotionConditions.trim() }
                      : {}),
                  },
                ]
              : [],
        },
        insufficientFactPolicy: values.insufficientFactPolicy,
      };
    case 'confirmation':
      return { type: 'confirm' };
  }
}

export function reduceOnboardingInteraction(
  state: OnboardingInteractionState,
  action: OnboardingInteractionAction,
): OnboardingInteractionState {
  switch (action.type) {
    case 'edit':
      return {
        notice: action.notice ?? '字段已在本页更新，尚未保存到服务端。',
        status: 'editing',
      };
    case 'request_started':
      return {
        notice:
          action.operation === 'pause'
            ? '正在请求暂停…'
            : action.operation === 'resume'
              ? '正在请求恢复…'
              : '正在提交到服务端…',
        status:
          action.operation === 'pause'
            ? 'pausing'
            : action.operation === 'resume'
              ? 'resuming'
              : 'saving',
      };
    case 'server_succeeded': {
      const nextStatus: InteractionStatus =
        action.result.state === 'cancelled'
          ? 'paused'
          : action.result.state === 'generating'
            ? 'generating'
            : action.result.state === 'manageable'
              ? 'generated'
              : 'saved';
      return {
        notice:
          nextStatus === 'paused'
            ? '服务端已确认暂停，可稍后恢复。'
            : nextStatus === 'generating'
              ? '服务端已接受生成请求，正在生成。'
              : nextStatus === 'generated'
                ? '服务端已确认生成完成。'
                : '服务端已确认保存。',
        result: action.result,
        status: nextStatus,
      };
    }
    case 'request_failed':
      if (action.error.kind === 'conflict') {
        return {
          notice: '服务端状态已经变化，请刷新最新进度后再提交。',
          requestId: action.error.requestId,
          status: 'conflict',
        };
      }
      if (
        action.error.kind === 'authentication_expired' ||
        action.error.kind === 'authentication_required'
      ) {
        return {
          notice: '授权已失效或尚未完成，请重新进行安全绑定。',
          requestId: action.error.requestId,
          status: 'authentication_expired',
        };
      }
      if (action.error.kind === 'binding_required') {
        return {
          notice: '需要先完成安全商家绑定，当前资料未提交。',
          requestId: action.error.requestId,
          status: 'binding_required',
        };
      }
      if (action.error.kind === 'merchant_selection_required') {
        return {
          notice: '当前身份关联多个商家，请先在安全页面选择商家。',
          requestId: action.error.requestId,
          status: 'merchant_selection_required',
        };
      }
      if (action.error.kind === 'generation_unavailable') {
        return {
          notice: '客服生成尚未接通或暂不可用，服务端未生成客服。',
          requestId: action.error.requestId,
          status: 'generation_unavailable',
        };
      }
      return {
        notice: action.error.message,
        requestId: action.error.requestId,
        status: 'error',
      };
  }
}
