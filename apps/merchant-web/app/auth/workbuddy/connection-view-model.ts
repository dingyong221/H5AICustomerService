export type WorkBuddyConnectionState =
  | 'unconfigured'
  | 'disconnected'
  | 'callback_pending'
  | 'callback_rejected'
  | 'signed_in'
  | 'consent_required'
  | 'binding_required'
  | 'authorization_failed'
  | 'merchant_selection_required'
  | 'conflict'
  | 'revoked';

export type TrustedWorkBuddyConnectionState =
  | 'disconnected'
  | 'signed_in'
  | 'consent_required'
  | 'binding_required'
  | 'authorization_failed'
  | 'merchant_selection_required'
  | 'conflict'
  | 'revoked';

type SearchValue = string | readonly string[] | undefined;

export interface WorkBuddyConnectionViewModel {
  actionLabel: string;
  authorizationHref?: string | undefined;
  description: string;
  label: string;
  state: WorkBuddyConnectionState;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}

export const secureAuthorizationLinkAttributes = {
  referrerPolicy: 'no-referrer',
  rel: 'noreferrer',
} as const;

interface BuildConnectionViewModelInput {
  allowedAuthorizationOrigins?: readonly string[];
  applicationOrigin?: string;
  callbackParameters?: Readonly<Record<string, SearchValue>>;
  serverAuthorizationEntry?: string;
  trustedServerState?: TrustedWorkBuddyConnectionState;
}

const allowedCallbackKeys = new Set(['code', 'error', 'error_description', 'error_uri', 'state']);

const sensitiveAuthorizationKeys = new Set([
  'access_token',
  'code',
  'error',
  'error_description',
  'error_uri',
  'id_token',
  'open_id',
  'openid',
  'otp',
  'password',
  'refresh_token',
  'token',
]);

function toHttpsOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function resolveSecureAuthorizationEntry(input: {
  allowedAuthorizationOrigins?: readonly string[];
  applicationOrigin?: string;
  serverAuthorizationEntry?: string;
}): string | undefined {
  const rawEntry = input.serverAuthorizationEntry?.trim();
  if (rawEntry === undefined || rawEntry.length === 0) return undefined;

  const applicationOrigin = toHttpsOrigin(input.applicationOrigin);
  let target: URL;
  try {
    target =
      applicationOrigin === undefined ? new URL(rawEntry) : new URL(rawEntry, applicationOrigin);
  } catch {
    return undefined;
  }

  if (
    target.protocol !== 'https:' ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    target.hash.length > 0
  ) {
    return undefined;
  }

  const allowedOrigins = new Set(
    (input.allowedAuthorizationOrigins ?? [])
      .map((origin) => toHttpsOrigin(origin))
      .filter((origin): origin is string => origin !== undefined),
  );
  if (target.origin !== applicationOrigin && !allowedOrigins.has(target.origin)) return undefined;

  for (const key of target.searchParams.keys()) {
    if (sensitiveAuthorizationKeys.has(key.toLowerCase())) return undefined;
  }

  return target.href;
}

function singleSafeValue(value: SearchValue, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) return undefined;
  return normalized;
}

function classifyCallback(
  parameters: Readonly<Record<string, SearchValue>> | undefined,
): WorkBuddyConnectionState | undefined {
  if (parameters === undefined) return undefined;
  const keys = Object.keys(parameters);
  if (keys.length === 0) return undefined;
  if (keys.some((key) => !allowedCallbackKeys.has(key))) return 'callback_rejected';

  for (const key of keys) {
    const limit = key === 'code' ? 2_048 : 1_024;
    if (singleSafeValue(parameters[key], limit) === undefined) return 'callback_rejected';
  }

  const error = singleSafeValue(parameters['error'], 1_024);
  if (error !== undefined) return 'callback_rejected';

  const code = singleSafeValue(parameters['code'], 2_048);
  const state = singleSafeValue(parameters['state'], 1_024);
  if (code !== undefined && state !== undefined) return 'callback_pending';
  return 'callback_rejected';
}

const statePresentation: Readonly<
  Record<
    WorkBuddyConnectionState,
    Omit<WorkBuddyConnectionViewModel, 'authorizationHref' | 'state'>
  >
> = {
  unconfigured: {
    actionLabel: '授权服务未配置',
    description: '服务端尚未提供经过校验的授权入口，当前不能开始连接。',
    label: '未配置',
    tone: 'neutral',
  },
  disconnected: {
    actionLabel: '前往 WorkBuddy 安全授权',
    description: '尚未建立连接。授权完成前不会创建商家绑定或登录会话。',
    label: '尚未连接',
    tone: 'warning',
  },
  callback_pending: {
    actionLabel: '等待服务端核验回调',
    description: '页面只确认收到受限回调；代码交换、state 校验和登录结果仍由服务端决定。',
    label: '回调待核验',
    tone: 'info',
  },
  callback_rejected: {
    actionLabel: '重新进行安全授权',
    description: '回调格式无效或提供方返回错误，页面没有据此建立任何可信登录或绑定状态。',
    label: '回调无效',
    tone: 'danger',
  },
  signed_in: {
    actionLabel: '服务端已确认登录',
    description: '服务端已确认有效登录会话；后续操作仍会逐次校验商家和客服权限。',
    label: '已登录',
    tone: 'success',
  },
  consent_required: {
    actionLabel: '查看并同意授权',
    description: '服务端要求完成授权同意；只有经过校验的 HTTPS 授权入口可以继续。',
    label: '需要授权同意',
    tone: 'warning',
  },
  binding_required: {
    actionLabel: '开始安全绑定',
    description: '服务端已确认当前登录尚未绑定商家，需要通过受控授权流程继续。',
    label: '需要绑定商家',
    tone: 'warning',
  },
  authorization_failed: {
    actionLabel: '重新进行安全授权',
    description: '服务端未确认本次授权，未建立连接，也不会保留回调中的敏感值。',
    label: '授权失败',
    tone: 'danger',
  },
  merchant_selection_required: {
    actionLabel: '等待安全商家选择入口',
    description: '当前身份关联多个商家，必须由服务端提供受控选择流程后才能继续。',
    label: '多商家待选择',
    tone: 'warning',
  },
  conflict: {
    actionLabel: '等待解决绑定冲突',
    description: '服务端发现身份或商家绑定冲突，页面不会覆盖现有绑定或继续授权。',
    label: '绑定冲突',
    tone: 'danger',
  },
  revoked: {
    actionLabel: '重新进行安全授权',
    description: '服务端确认授权已经撤销；旧会话和页面参数不能恢复授权。',
    label: '授权已撤销',
    tone: 'danger',
  },
};

export function buildWorkBuddyConnectionViewModel(
  input: BuildConnectionViewModelInput,
): WorkBuddyConnectionViewModel {
  const authorizationHref = resolveSecureAuthorizationEntry(input);
  const callbackState = classifyCallback(input.callbackParameters);
  let state = input.trustedServerState ?? callbackState;
  if (state === undefined)
    state = authorizationHref === undefined ? 'unconfigured' : 'disconnected';
  if (state === 'disconnected' && authorizationHref === undefined) state = 'unconfigured';

  const presentation = statePresentation[state];
  const canAuthorize =
    authorizationHref !== undefined &&
    (state === 'disconnected' ||
      state === 'callback_rejected' ||
      state === 'consent_required' ||
      state === 'binding_required' ||
      state === 'authorization_failed' ||
      state === 'revoked');

  return {
    ...presentation,
    ...(canAuthorize ? { authorizationHref } : {}),
    state,
  };
}
