import type { WorkBuddyAuthorizationResult } from '@h5cs/contracts';

export type WorkBuddyConnectionState =
  | 'authorization_failed'
  | 'authorized'
  | 'backend_unavailable'
  | 'conflict'
  | 'consent_required'
  | 'login_required'
  | 'merchant_access_required'
  | 'merchant_selection_required'
  | 'revoked'
  | 'workbuddy_authorization_required';

export type WorkBuddyAuthorizationStep = 'login' | 'binding' | 'merchant' | 'consent';

export type TrustedWorkBuddyAuthorizationSnapshot =
  WorkBuddyAuthorizationResult | Readonly<{ status: 'backend_unavailable' }>;

export interface WorkBuddyAuthorizationStepViewModel {
  id: WorkBuddyAuthorizationStep;
  label: string;
  status: 'blocked' | 'complete' | 'current' | 'pending';
}

export interface WorkBuddyMerchantOptionViewModel {
  displayName: string;
  reference: string;
}

export interface WorkBuddyConsentViewModel {
  merchantDisplayName: string;
  permissions: readonly string[];
  scope: 'mcp:tools';
}

export interface WorkBuddyConnectionViewModel {
  actionLabel: string;
  authorizationHref?: string | undefined;
  blocked: boolean;
  canConsent: boolean;
  canContinue: boolean;
  canRetry: boolean;
  canStart: boolean;
  consent?: WorkBuddyConsentViewModel | undefined;
  description: string;
  label: string;
  merchants: readonly WorkBuddyMerchantOptionViewModel[];
  securityNotice?: string | undefined;
  state: WorkBuddyConnectionState;
  steps: readonly WorkBuddyAuthorizationStepViewModel[];
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  transactionRef?: string | undefined;
}

export const secureAuthorizationLinkAttributes = {
  referrerPolicy: 'no-referrer',
  rel: 'noreferrer',
} as const;

interface BuildConnectionViewModelInput {
  trustedServerSnapshot?: TrustedWorkBuddyAuthorizationSnapshot | undefined;
  untrustedCallbackPresent?: boolean | undefined;
}

const permissionDescriptions = [
  '查看帮助与当前授权状态',
  '创建或恢复首次生成流程',
  '推进已确认的首次生成步骤',
  '打开当前商家的受保护管理入口',
] as const;

const stepLabels: Readonly<Record<WorkBuddyAuthorizationStep, string>> = {
  login: '平台账号登录',
  binding: '绑定 WorkBuddy 身份',
  merchant: '确认单一商家',
  consent: '明确授权同意',
};

const sensitiveAuthorizationQueryKeys = new Set([
  'access_token',
  'code',
  'id_token',
  'open_id',
  'openid',
  'password',
  'refresh_token',
  'token',
]);

export function resolveWorkBuddyAuthorizationUrl(value: string): string | undefined {
  try {
    const target = new URL(value);
    if (
      target.protocol !== 'https:' ||
      target.origin !== 'https://www.workbuddy.cn' ||
      target.pathname !== '/openapi/v2/oauth/authorize' ||
      target.username.length > 0 ||
      target.password.length > 0 ||
      target.hash.length > 0
    ) {
      return undefined;
    }
    for (const key of target.searchParams.keys()) {
      if (sensitiveAuthorizationQueryKeys.has(key.toLowerCase())) return undefined;
    }
    return target.href;
  } catch {
    return undefined;
  }
}

function buildSteps(
  state: WorkBuddyConnectionState,
): readonly WorkBuddyAuthorizationStepViewModel[] {
  const stepIds = Object.keys(stepLabels) as WorkBuddyAuthorizationStep[];
  const currentIndex =
    state === 'login_required'
      ? 0
      : state === 'workbuddy_authorization_required' || state === 'conflict'
        ? 1
        : state === 'merchant_access_required' || state === 'merchant_selection_required'
          ? 2
          : state === 'consent_required'
            ? 3
            : state === 'authorized'
              ? 4
              : -1;

  return stepIds.map((id, index) => ({
    id,
    label: stepLabels[id],
    status:
      state === 'backend_unavailable' || state === 'authorization_failed' || state === 'revoked'
        ? 'blocked'
        : currentIndex === 4 || index < currentIndex
          ? 'complete'
          : index === currentIndex
            ? 'current'
            : 'pending',
  }));
}

const presentation: Readonly<
  Record<
    WorkBuddyConnectionState,
    Pick<WorkBuddyConnectionViewModel, 'actionLabel' | 'description' | 'label' | 'tone'>
  >
> = {
  authorization_failed: {
    actionLabel: '重新开始安全授权',
    description: '可信服务端未完成本次授权；旧回调参数不能恢复任何登录或授权状态。',
    label: '授权失败',
    tone: 'danger',
  },
  authorized: {
    actionLabel: '继续使用',
    description: '可信服务端确认登录、身份绑定、单一商家和 consent 均已完成。',
    label: '已完成授权',
    tone: 'success',
  },
  backend_unavailable: {
    actionLabel: '重新检查服务状态',
    description: '授权服务未配置、不可达或返回了不可信响应，页面已停止继续。',
    label: '授权后端不可用',
    tone: 'neutral',
  },
  conflict: {
    actionLabel: '重新检查服务状态',
    description: '可信服务端发现身份绑定冲突；当前页面不会覆盖、合并或迁移账号。',
    label: '身份绑定冲突',
    tone: 'danger',
  },
  consent_required: {
    actionLabel: '明确同意或拒绝',
    description: '服务端已锁定当前事务的单一商家；仍需明确确认 Connector 授权范围。',
    label: '需要授权同意',
    tone: 'warning',
  },
  login_required: {
    actionLabel: '验证登录并开始授权',
    description: '可信服务端确认当前浏览器尚未登录；页面不会用 URL 或缓存代替平台会话。',
    label: '需要平台登录',
    tone: 'warning',
  },
  merchant_access_required: {
    actionLabel: '等待商家创建或邀请',
    description: '当前授权事务没有可用商家；有效 Membership 生效前不能继续。',
    label: '暂无可授权商家',
    tone: 'warning',
  },
  merchant_selection_required: {
    actionLabel: '选择一个商家后继续',
    description: '必须从服务端候选中明确选择一个商家，页面不会设置默认选项。',
    label: '需要选择商家',
    tone: 'warning',
  },
  revoked: {
    actionLabel: '重新开始安全授权',
    description: '可信服务端确认原授权已撤销；旧 URL 或页面缓存不能恢复授权。',
    label: '授权已撤销',
    tone: 'danger',
  },
  workbuddy_authorization_required: {
    actionLabel: '前往 WorkBuddy 安全授权',
    description: '平台会话已确认，下一步只能通过服务端签发的 WorkBuddy OAuth 地址继续。',
    label: '需要 WorkBuddy 授权',
    tone: 'info',
  },
};

function consentView(): WorkBuddyConsentViewModel {
  return {
    merchantDisplayName: '服务端已锁定的单一商家',
    permissions: permissionDescriptions,
    scope: 'mcp:tools',
  };
}

export function buildWorkBuddyConnectionViewModel(
  input: BuildConnectionViewModelInput,
): WorkBuddyConnectionViewModel {
  const snapshot = input.trustedServerSnapshot ?? { status: 'backend_unavailable' };
  let state: WorkBuddyConnectionState;
  let authorizationHref: string | undefined;
  let transactionRef: string | undefined;
  let merchants: readonly WorkBuddyMerchantOptionViewModel[] = [];
  let consent: WorkBuddyConsentViewModel | undefined;

  switch (snapshot.status) {
    case 'backend_unavailable':
      state = 'backend_unavailable';
      break;
    case 'sign_in_required':
      state = 'login_required';
      break;
    case 'signed_in':
      state = 'workbuddy_authorization_required';
      transactionRef = snapshot.transaction_ref;
      authorizationHref = resolveWorkBuddyAuthorizationUrl(snapshot.authorization_url);
      break;
    case 'binding_required':
      state = 'merchant_access_required';
      transactionRef = snapshot.transaction_ref;
      break;
    case 'merchant_selection_required':
      state = snapshot.candidates.length === 0 ? 'merchant_access_required' : snapshot.status;
      transactionRef = snapshot.transaction_ref;
      merchants = snapshot.candidates.map((candidate) => ({
        displayName: candidate.display_name,
        reference: candidate.candidate_ref,
      }));
      break;
    case 'consent_required':
      state = 'consent_required';
      transactionRef = snapshot.transaction_ref;
      consent = consentView();
      break;
    case 'connected':
      state = 'authorized';
      consent = consentView();
      break;
    case 'authorization_failed':
    case 'conflict':
    case 'revoked':
      state = snapshot.status;
      break;
  }

  const statePresentation = presentation[state];
  return {
    ...statePresentation,
    ...(authorizationHref === undefined ? {} : { authorizationHref }),
    blocked:
      state === 'backend_unavailable' ||
      state === 'merchant_access_required' ||
      (state === 'workbuddy_authorization_required' && authorizationHref === undefined),
    canConsent: state === 'consent_required' && transactionRef !== undefined,
    canContinue: state === 'authorized',
    canRetry:
      state === 'backend_unavailable' ||
      state === 'authorization_failed' ||
      state === 'conflict' ||
      state === 'revoked',
    canStart:
      state === 'login_required' ||
      state === 'authorization_failed' ||
      state === 'conflict' ||
      state === 'revoked',
    ...(consent === undefined ? {} : { consent }),
    merchants,
    ...(input.untrustedCallbackPresent === true
      ? {
          securityNotice:
            '检测到 URL 参数；它们只会作为指针提交给服务端验证，不会直接改变登录、商家或授权状态。',
        }
      : {}),
    state,
    steps: buildSteps(state),
    ...(transactionRef === undefined ? {} : { transactionRef }),
  };
}
