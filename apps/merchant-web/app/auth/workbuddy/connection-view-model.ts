export type WorkBuddyConnectionState =
  | 'unconfigured'
  | 'disconnected'
  | 'connected'
  | 'authorization_failed'
  | 'binding_pending'
  | 'merchant_selection_required';

export type TrustedWorkBuddyConnectionState = Exclude<WorkBuddyConnectionState, 'unconfigured'>;

type SearchValue = string | readonly string[] | undefined;

export interface WorkBuddyConnectionViewModel {
  actionLabel: string;
  authorizationHref?: string | undefined;
  description: string;
  label: string;
  state: WorkBuddyConnectionState;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}

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
  if (keys.some((key) => !allowedCallbackKeys.has(key))) return 'authorization_failed';

  for (const key of keys) {
    const limit = key === 'code' ? 2_048 : 1_024;
    if (singleSafeValue(parameters[key], limit) === undefined) return 'authorization_failed';
  }

  const error = singleSafeValue(parameters['error'], 1_024);
  if (error !== undefined) {
    return error === 'merchant_selection_required'
      ? 'merchant_selection_required'
      : 'authorization_failed';
  }

  const code = singleSafeValue(parameters['code'], 2_048);
  const state = singleSafeValue(parameters['state'], 1_024);
  if (code !== undefined && state !== undefined) return 'binding_pending';
  return 'authorization_failed';
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
  connected: {
    actionLabel: '已安全连接',
    description: '服务端已确认连接；后续操作仍会逐次校验登录会话与商家权限。',
    label: '已连接',
    tone: 'success',
  },
  authorization_failed: {
    actionLabel: '重新进行安全授权',
    description: '服务端未确认本次授权，未建立连接，也不会保留回调中的敏感值。',
    label: '授权失败',
    tone: 'danger',
  },
  binding_pending: {
    actionLabel: '等待服务端完成绑定',
    description: '已收到受限回调，但只有服务端完成代码交换和状态校验后才能认定连接成功。',
    label: '绑定待完成',
    tone: 'info',
  },
  merchant_selection_required: {
    actionLabel: '等待安全商家选择入口',
    description: '当前身份关联多个商家，必须由服务端提供受控选择流程后才能继续。',
    label: '多商家待选择',
    tone: 'warning',
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
    (state === 'disconnected' || state === 'authorization_failed');

  return {
    ...presentation,
    ...(canAuthorize ? { authorizationHref } : {}),
    state,
  };
}
