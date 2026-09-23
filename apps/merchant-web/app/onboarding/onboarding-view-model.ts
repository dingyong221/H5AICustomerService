import type { OnboardingMissingItemContract, SkillIntentResult } from '@h5cs/contracts';
import type { ProgressStep, ProgressStepStatus, StatusBadgeProps } from '@h5cs/ui';

type ContinueOnboardingResult = Extract<SkillIntentResult, { action: 'continue_onboarding' }>;
type OnboardingContractState = ContinueOnboardingResult['state'];
type StepId = 'industry' | 'materials' | 'policy' | 'confirmation';

export type WorkBuddyAuthorization = 'authorized' | 'binding_required';

export interface WorkBuddyIdentityViewModel {
  actionHref: string | undefined;
  actionLabel: string | undefined;
  description: string;
  label: 'WorkBuddy已授权' | '需要安全绑定';
  tone: NonNullable<StatusBadgeProps['tone']>;
}

export interface WorkBuddyEntryViewModel {
  create: {
    description: string;
    href: string;
    label: string;
  };
  identity: WorkBuddyIdentityViewModel;
  manage: {
    description: string;
    href: string;
    label: string;
    requiresLogin: true;
  };
}

export interface MissingItemViewModel {
  code: OnboardingMissingItemContract['code'];
  message: string;
  stepId: StepId;
  stepLabel: string;
}

export interface OnboardingViewModel {
  canCancel: boolean;
  canResume: boolean;
  canSubmit: boolean;
  connectionLabel: string;
  helpHref: string;
  identity: WorkBuddyIdentityViewModel;
  isReadOnly: boolean;
  missingItems: readonly MissingItemViewModel[];
  missingItemsLabel: string;
  primaryActionLabel: string;
  state: OnboardingContractState | undefined;
  statusLabel: string;
  steps: readonly ProgressStep[];
}

const stepDefinitions: ReadonlyArray<Readonly<Pick<ProgressStep, 'id' | 'label' | 'description'>>> =
  [
    { id: 'industry', label: '行业', description: '确认所属行业与服务方向' },
    { id: 'materials', label: '业务资料', description: '产品、商品或服务的真实资料' },
    { id: 'policy', label: '售卖策略', description: '价格、优惠与资料不足规则' },
    { id: 'confirmation', label: '确认生成', description: '复核后提交服务端生成' },
  ];

const stateStepIndex: Readonly<Partial<Record<OnboardingContractState, number>>> = {
  confirmation: 3,
  generating: 3,
  industry: 0,
  materials: 1,
  policy: 2,
};

const missingItemStep: Readonly<Record<OnboardingMissingItemContract['code'], StepId>> = {
  business_description: 'materials',
  business_name: 'materials',
  industry_code: 'industry',
  insufficient_fact_policy: 'policy',
  material_reference: 'materials',
  merchant_confirmation: 'confirmation',
  offering: 'materials',
  pricing_policy: 'policy',
  promotion_policy: 'policy',
};

const stepLabels: Readonly<Record<StepId, string>> = {
  confirmation: '确认生成',
  industry: '行业',
  materials: '业务资料',
  policy: '售卖策略',
};

const statusLabels: Readonly<Record<OnboardingContractState, string>> = {
  cancelled: '引导已取消，可从服务端恢复',
  confirmation: '等待商家确认',
  generating: '服务端正在生成',
  industry: '等待填写行业',
  manageable: '客服已生成，可登录管理',
  materials: '等待补充业务资料',
  policy: '等待确认售卖策略',
};

const primaryActionLabels: Readonly<Record<OnboardingContractState, string>> = {
  cancelled: '恢复引导',
  confirmation: '确认并开始生成',
  generating: '正在生成',
  industry: '保存行业并继续',
  manageable: '登录后管理客服',
  materials: '保存资料并继续',
  policy: '保存策略并继续',
};

export function buildWorkBuddyIdentityViewModel(
  authorization: WorkBuddyAuthorization,
): WorkBuddyIdentityViewModel {
  if (authorization === 'authorized') {
    return {
      actionHref: undefined,
      actionLabel: undefined,
      description: '授权身份仍需由服务端会话校验，不能由页面自行认定。',
      label: 'WorkBuddy已授权',
      tone: 'success',
    };
  }

  return {
    actionHref: '/auth/workbuddy/bind',
    actionLabel: '前往 HTTPS 安全绑定页',
    description: '仅在本站安全页面完成绑定，管理入口仍要求有效登录会话。',
    label: '需要安全绑定',
    tone: 'warning',
  };
}

function toLoginGate(rawManagementUrl: string | undefined, applicationOrigin: string): string {
  if (rawManagementUrl === undefined) return '/account/login';
  try {
    const target = new URL(rawManagementUrl);
    if (target.origin !== applicationOrigin || target.search || target.hash)
      return '/account/login';
    const merchantId = /^\/workspace\/([0-9a-f]{32})(?:\/|$)/u.exec(target.pathname)?.[1];
    if (!merchantId) return '/account/login';
    const allowedPath = new RegExp(`^/workspace/${merchantId}(?:/assistants/[0-9a-f]{32})?$`, 'u');
    return allowedPath.test(target.pathname)
      ? `/account/login?merchant=${merchantId}&next=${encodeURIComponent(target.pathname)}`
      : '/account/login';
  } catch {
    return '/account/login';
  }
}

export function buildWorkBuddyEntryViewModel(input: {
  applicationOrigin?: string;
  authorization: WorkBuddyAuthorization;
  result?: SkillIntentResult;
}): WorkBuddyEntryViewModel {
  const managementUrl =
    input.result?.action === 'open_management_console' ? input.result.url : undefined;
  const applicationOrigin = input.applicationOrigin ?? 'https://h5cs.1rying.com';

  return {
    create: {
      description: '按四步补充真实业务资料，确认后再由服务端生成客服草稿。',
      href: '/onboarding',
      label: '首次生成AI客服',
    },
    identity: buildWorkBuddyIdentityViewModel(input.authorization),
    manage: {
      description: '先建立有效登录会话，再进入已有客服的配置、知识和发布页面。',
      href: toLoginGate(managementUrl, applicationOrigin),
      label: '继续管理已有客服',
      requiresLogin: true,
    },
  };
}

function getStepStatus(
  state: OnboardingContractState | undefined,
  index: number,
): ProgressStepStatus {
  if (state === undefined) return index === 0 ? 'blocked' : 'upcoming';
  if (state === 'manageable') return 'complete';
  if (state === 'cancelled') return 'paused';

  const activeIndex = stateStepIndex[state];
  if (activeIndex === undefined) return 'upcoming';
  if (index < activeIndex) return 'complete';
  if (index === activeIndex) return 'current';
  return 'upcoming';
}

export function buildOnboardingViewModel(input: {
  apiConnected: boolean;
  authorization: WorkBuddyAuthorization;
  result?: SkillIntentResult;
}): OnboardingViewModel {
  const continuation = input.result?.action === 'continue_onboarding' ? input.result : undefined;
  const state = continuation?.state;
  const authorized = input.authorization === 'authorized';
  const actionable = input.apiConnected && authorized;
  const missingItems = (continuation?.missing_items ?? []).map((item) => {
    const stepId = missingItemStep[item.code];
    return {
      code: item.code,
      message: item.message,
      stepId,
      stepLabel: stepLabels[stepId],
    } satisfies MissingItemViewModel;
  });

  return {
    canCancel: actionable && state !== undefined && state !== 'cancelled' && state !== 'manageable',
    canResume: actionable && state === 'cancelled',
    canSubmit: actionable && state === 'confirmation' && missingItems.length === 0,
    connectionLabel: input.apiConnected ? '管理 API 已连接' : '管理 API 尚未连接',
    helpHref: '/onboarding#help',
    identity: buildWorkBuddyIdentityViewModel(input.authorization),
    isReadOnly: !actionable,
    missingItems,
    missingItemsLabel:
      continuation === undefined
        ? '尚未从服务端读取缺失项'
        : missingItems.length === 0
          ? '服务端未返回缺失项'
          : `仍有 ${missingItems.length} 项待补充`,
    primaryActionLabel:
      !input.apiConnected || state === undefined
        ? '连接服务后继续'
        : !authorized
          ? '安全绑定后继续'
          : primaryActionLabels[state],
    state,
    statusLabel: state === undefined ? '尚未建立 onboarding 会话' : statusLabels[state],
    steps: stepDefinitions.map((step, index) => ({
      ...step,
      status: getStepStatus(state, index),
    })),
  };
}
