export type WorkBuddyConnectionState =
  | 'backend_unavailable'
  | 'login_required'
  | 'binding_required'
  | 'merchant_access_required'
  | 'merchant_selection_required'
  | 'consent_required'
  | 'authorized'
  | 'authorization_failed'
  | 'conflict'
  | 'revoked';

export type WorkBuddyAuthorizationStep = 'login' | 'binding' | 'merchant' | 'consent';

export interface TrustedServerNavigation {
  href: string;
}

export interface WorkBuddyMerchantCandidate {
  displayName: string;
  reference: string;
  roleLabel: string;
  selectionAction?: TrustedServerNavigation | undefined;
}

type ConnectorContext = Readonly<{
  connectorLabel: string;
  scope: 'mcp:tools';
}>;

export type TrustedWorkBuddyAuthorizationSnapshot =
  | Readonly<{ stage: 'backend_unavailable' }>
  | Readonly<{
      stage: 'login_required';
      loginAction?: TrustedServerNavigation | undefined;
    }>
  | Readonly<{
      accountLabel: string;
      bindingAction?: TrustedServerNavigation | undefined;
      stage: 'binding_required';
    }>
  | (ConnectorContext &
      Readonly<{
        emptyMerchantAction?: TrustedServerNavigation | undefined;
        merchants: readonly WorkBuddyMerchantCandidate[];
        singleMerchantConsentAction?: TrustedServerNavigation | undefined;
        stage: 'merchant_resolution_required';
      }>)
  | (ConnectorContext &
      Readonly<{
        merchant: WorkBuddyMerchantCandidate;
        stage: 'consent_required';
      }>)
  | Readonly<{
      connectorLabel: string;
      managementAction?: TrustedServerNavigation | undefined;
      merchant: WorkBuddyMerchantCandidate;
      stage: 'authorized';
    }>
  | Readonly<{
      recoveryAction?: TrustedServerNavigation | undefined;
      stage: 'authorization_failed' | 'conflict' | 'revoked';
    }>;

export interface WorkBuddyAuthorizationStepViewModel {
  id: WorkBuddyAuthorizationStep;
  label: string;
  status: 'blocked' | 'complete' | 'current' | 'pending';
}

export interface WorkBuddyMerchantOptionViewModel {
  displayName: string;
  reference: string;
  roleLabel: string;
  selectionHref?: string | undefined;
}

export interface WorkBuddyConsentViewModel {
  connectorLabel: string;
  merchantDisplayName: string;
  permissions: readonly string[];
  scope: 'mcp:tools';
}

export interface WorkBuddyConnectionViewModel {
  actionLabel: string;
  authorizationHref?: string | undefined;
  blocked: boolean;
  consent?: WorkBuddyConsentViewModel | undefined;
  description: string;
  label: string;
  merchants: readonly WorkBuddyMerchantOptionViewModel[];
  securityNotice?: string | undefined;
  state: WorkBuddyConnectionState;
  steps: readonly WorkBuddyAuthorizationStepViewModel[];
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}

export const secureAuthorizationLinkAttributes = {
  referrerPolicy: 'no-referrer',
  rel: 'noreferrer',
} as const;

interface BuildConnectionViewModelInput {
  applicationOrigin?: string | undefined;
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

const sensitiveQueryKeys = new Set([
  'access_token',
  'code',
  'id_token',
  'open_id',
  'openid',
  'otp',
  'password',
  'refresh_token',
  'state',
  'token',
]);

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

function parseApplicationOrigin(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export function resolveSecureServerNavigation(input: {
  applicationOrigin?: string | undefined;
  navigation?: TrustedServerNavigation | undefined;
}): string | undefined {
  const applicationOrigin = parseApplicationOrigin(input.applicationOrigin);
  const rawHref = input.navigation?.href.trim();
  if (applicationOrigin === undefined || rawHref === undefined || rawHref.length === 0) {
    return undefined;
  }

  try {
    const target = new URL(rawHref, applicationOrigin);
    const allowedPath =
      target.pathname === '/login' ||
      target.pathname.startsWith('/login/') ||
      target.pathname === '/auth/workbuddy' ||
      target.pathname.startsWith('/auth/workbuddy/');
    if (
      target.origin !== applicationOrigin.origin ||
      target.username.length > 0 ||
      target.password.length > 0 ||
      target.hash.length > 0 ||
      !allowedPath
    ) {
      return undefined;
    }
    for (const key of target.searchParams.keys()) {
      if (sensitiveQueryKeys.has(key.toLowerCase())) return undefined;
    }
    return target.href;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function safeText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function decodeNavigation(value: unknown): TrustedServerNavigation | undefined {
  if (!isRecord(value)) return undefined;
  const href = safeText(value['href'], 2_048);
  return href === undefined ? undefined : { href };
}

function decodeMerchant(value: unknown): WorkBuddyMerchantCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const displayName = safeText(value['displayName'], 80);
  const reference = safeText(value['reference'], 128);
  const roleLabel = safeText(value['roleLabel'], 40);
  if (
    displayName === undefined ||
    reference === undefined ||
    roleLabel === undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(reference)
  ) {
    return undefined;
  }
  const selectionAction = decodeNavigation(value['selectionAction']);
  return {
    displayName,
    reference,
    roleLabel,
    ...(selectionAction === undefined ? {} : { selectionAction }),
  };
}

function decodeConnectorContext(
  value: Readonly<Record<string, unknown>>,
): ConnectorContext | undefined {
  const connectorLabel = safeText(value['connectorLabel'], 120);
  if (connectorLabel === undefined || value['scope'] !== 'mcp:tools') return undefined;
  return { connectorLabel, scope: 'mcp:tools' };
}

export function decodeTrustedWorkBuddyAuthorizationSnapshot(
  value: unknown,
): TrustedWorkBuddyAuthorizationSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  switch (value['stage']) {
    case 'backend_unavailable':
      return { stage: 'backend_unavailable' };
    case 'login_required': {
      const loginAction = decodeNavigation(value['loginAction']);
      return { stage: 'login_required', ...(loginAction === undefined ? {} : { loginAction }) };
    }
    case 'binding_required': {
      const accountLabel = safeText(value['accountLabel'], 120);
      if (accountLabel === undefined) return undefined;
      const bindingAction = decodeNavigation(value['bindingAction']);
      return {
        accountLabel,
        stage: 'binding_required',
        ...(bindingAction === undefined ? {} : { bindingAction }),
      };
    }
    case 'merchant_resolution_required': {
      const context = decodeConnectorContext(value);
      if (context === undefined || !Array.isArray(value['merchants'])) return undefined;
      const merchants = value['merchants'].map(decodeMerchant);
      if (
        merchants.length > 20 ||
        merchants.some((merchant) => merchant === undefined) ||
        new Set(merchants.map((merchant) => merchant?.reference)).size !== merchants.length
      ) {
        return undefined;
      }
      const emptyMerchantAction = decodeNavigation(value['emptyMerchantAction']);
      const singleMerchantConsentAction = decodeNavigation(value['singleMerchantConsentAction']);
      return {
        ...context,
        merchants: merchants as WorkBuddyMerchantCandidate[],
        stage: 'merchant_resolution_required',
        ...(emptyMerchantAction === undefined ? {} : { emptyMerchantAction }),
        ...(singleMerchantConsentAction === undefined ? {} : { singleMerchantConsentAction }),
      };
    }
    case 'consent_required': {
      const context = decodeConnectorContext(value);
      const merchant = decodeMerchant(value['merchant']);
      if (context === undefined || merchant === undefined) return undefined;
      return { ...context, merchant, stage: 'consent_required' };
    }
    case 'authorized': {
      const connectorLabel = safeText(value['connectorLabel'], 120);
      const merchant = decodeMerchant(value['merchant']);
      if (connectorLabel === undefined || merchant === undefined) return undefined;
      const managementAction = decodeNavigation(value['managementAction']);
      return {
        connectorLabel,
        merchant,
        stage: 'authorized',
        ...(managementAction === undefined ? {} : { managementAction }),
      };
    }
    case 'authorization_failed':
    case 'conflict':
    case 'revoked': {
      const recoveryAction = decodeNavigation(value['recoveryAction']);
      return {
        stage: value['stage'],
        ...(recoveryAction === undefined ? {} : { recoveryAction }),
      };
    }
    default:
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
      : state === 'binding_required' || state === 'conflict'
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
  backend_unavailable: {
    actionLabel: '等待可信服务端路由',
    description: '尚未接入可验证的账号授权状态路由，页面已停止继续并且不会推断登录结果。',
    label: '授权后端不可用',
    tone: 'neutral',
  },
  login_required: {
    actionLabel: '前往平台安全登录',
    description: '可信服务端确认当前浏览器尚未登录；登录只建立平台会话，不自动绑定或授权。',
    label: '需要平台登录',
    tone: 'warning',
  },
  binding_required: {
    actionLabel: '开始绑定 WorkBuddy 身份',
    description: '平台账号已登录，但仍需由服务端发起独立的 WorkBuddy 身份桥接。',
    label: '需要身份绑定',
    tone: 'warning',
  },
  merchant_access_required: {
    actionLabel: '等待商家创建或邀请路由',
    description: '当前账号没有可管理商家；在服务端确认有效 Membership 前不能进入授权同意。',
    label: '暂无可授权商家',
    tone: 'warning',
  },
  merchant_selection_required: {
    actionLabel: '选择一个商家后继续',
    description: '当前账号关联多个商家；必须通过服务端提供的候选明确选择一个，页面不会默认选择。',
    label: '需要选择商家',
    tone: 'warning',
  },
  consent_required: {
    actionLabel: '等待服务端 consent 提交路由',
    description: '商家已经由可信服务端确定；仍需明确查看并同意当前 Connector 的授权范围。',
    label: '需要授权同意',
    tone: 'warning',
  },
  authorized: {
    actionLabel: '进入受保护管理页',
    description: '可信服务端确认登录、身份绑定、单一商家和 consent 均已完成。',
    label: '已完成授权',
    tone: 'success',
  },
  authorization_failed: {
    actionLabel: '重新开始安全授权',
    description: '可信服务端未完成本次授权；页面不会从回调文字恢复任何登录或商家状态。',
    label: '授权失败',
    tone: 'danger',
  },
  conflict: {
    actionLabel: '进入受控冲突恢复',
    description: '可信服务端发现身份绑定冲突；当前页面不会覆盖、合并或迁移任何账号。',
    label: '身份绑定冲突',
    tone: 'danger',
  },
  revoked: {
    actionLabel: '重新开始安全授权',
    description: '可信服务端确认原授权已撤销；旧URL、query或页面缓存不能恢复授权。',
    label: '授权已撤销',
    tone: 'danger',
  },
};

function consentFor(
  connectorLabel: string,
  merchant: WorkBuddyMerchantCandidate,
): WorkBuddyConsentViewModel {
  return {
    connectorLabel,
    merchantDisplayName: merchant.displayName,
    permissions: permissionDescriptions,
    scope: 'mcp:tools',
  };
}

export function buildWorkBuddyConnectionViewModel(
  input: BuildConnectionViewModelInput,
): WorkBuddyConnectionViewModel {
  const snapshot = input.trustedServerSnapshot ?? { stage: 'backend_unavailable' };
  let state: WorkBuddyConnectionState;
  let navigation: TrustedServerNavigation | undefined;
  let merchants: readonly WorkBuddyMerchantOptionViewModel[] = [];
  let consent: WorkBuddyConsentViewModel | undefined;
  let actionLabelOverride: string | undefined;

  switch (snapshot.stage) {
    case 'backend_unavailable':
      state = 'backend_unavailable';
      break;
    case 'login_required':
      state = 'login_required';
      navigation = snapshot.loginAction;
      break;
    case 'binding_required':
      state = 'binding_required';
      navigation = snapshot.bindingAction;
      break;
    case 'merchant_resolution_required':
      if (snapshot.merchants.length === 0) {
        state = 'merchant_access_required';
        navigation = snapshot.emptyMerchantAction;
      } else if (snapshot.merchants.length === 1) {
        state = 'consent_required';
        navigation = snapshot.singleMerchantConsentAction;
        actionLabelOverride = '查看并同意授权';
        consent = consentFor(snapshot.connectorLabel, snapshot.merchants[0]!);
      } else {
        state = 'merchant_selection_required';
        merchants = snapshot.merchants.map((merchant) => {
          const selectionHref = resolveSecureServerNavigation({
            applicationOrigin: input.applicationOrigin,
            navigation: merchant.selectionAction,
          });
          return {
            displayName: merchant.displayName,
            reference: merchant.reference,
            roleLabel: merchant.roleLabel,
            ...(selectionHref === undefined ? {} : { selectionHref }),
          };
        });
      }
      break;
    case 'consent_required':
      state = 'consent_required';
      consent = consentFor(snapshot.connectorLabel, snapshot.merchant);
      break;
    case 'authorized':
      state = 'authorized';
      navigation = snapshot.managementAction;
      consent = consentFor(snapshot.connectorLabel, snapshot.merchant);
      break;
    case 'authorization_failed':
    case 'conflict':
    case 'revoked':
      state = snapshot.stage;
      navigation = snapshot.recoveryAction;
      break;
  }

  const authorizationHref = resolveSecureServerNavigation({
    applicationOrigin: input.applicationOrigin,
    navigation,
  });
  const hasMerchantSelection = merchants.some((merchant) => merchant.selectionHref !== undefined);
  const statePresentation = presentation[state];
  const consentSubmissionMissing =
    state === 'consent_required' && snapshot.stage === 'consent_required';

  return {
    ...statePresentation,
    ...(actionLabelOverride === undefined ? {} : { actionLabel: actionLabelOverride }),
    blocked:
      state === 'backend_unavailable' ||
      state === 'authorization_failed' ||
      state === 'revoked' ||
      consentSubmissionMissing ||
      (state === 'merchant_selection_required'
        ? !hasMerchantSelection
        : authorizationHref === undefined),
    ...(authorizationHref === undefined ? {} : { authorizationHref }),
    ...(consent === undefined ? {} : { consent }),
    merchants,
    ...(input.untrustedCallbackPresent === true
      ? {
          securityNotice:
            '检测到URL参数，但它们不会改变登录、绑定、商家或授权状态；页面仅采用可信服务端快照。',
        }
      : {}),
    state,
    steps: buildSteps(state),
  };
}
