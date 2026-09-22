import {
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  workBuddyAuthorizationCallbackQuerySchema,
  workBuddyAuthorizationResultSchema,
  workBuddyAuthorizationStatusQuerySchema,
  workBuddyConsentRequestSchema,
  workBuddyMerchantSelectionRequestSchema,
  type WorkBuddyAuthorizationResult,
} from '@h5cs/contracts';

export type WorkBuddyAuthorizationClientErrorKind =
  | 'forbidden'
  | 'invalid_configuration'
  | 'invalid_request'
  | 'invalid_response'
  | 'transaction_expired'
  | 'unavailable';

export class WorkBuddyAuthorizationClientError extends Error {
  public constructor(
    public readonly kind: WorkBuddyAuthorizationClientErrorKind,
    message: string,
    public readonly retryable = false,
    public readonly requestId: string | undefined = undefined,
  ) {
    super(message);
    this.name = 'WorkBuddyAuthorizationClientError';
  }
}

export interface WorkBuddyAuthorizationApiClient {
  completeCallback(input: { code: string; state: string }): Promise<WorkBuddyAuthorizationResult>;
  readStatus(transactionRef?: string): Promise<WorkBuddyAuthorizationResult>;
  recordConsent(input: {
    decision: 'deny' | 'grant';
    transactionRef: string;
  }): Promise<WorkBuddyAuthorizationResult>;
  selectMerchant(input: {
    candidateRef: string;
    transactionRef: string;
  }): Promise<WorkBuddyAuthorizationResult>;
  startAuthorization(): Promise<WorkBuddyAuthorizationResult>;
}

interface ClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  getCsrfToken: () => string | undefined;
  origin: string;
}

const csrfTokenPattern = /^[A-Za-z0-9_-]{32,512}$/u;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function resolveBaseUrl(apiBaseUrl: string | undefined, origin: string): URL {
  if (apiBaseUrl === undefined || apiBaseUrl.trim().length === 0) {
    throw new WorkBuddyAuthorizationClientError(
      'invalid_configuration',
      'WorkBuddy 授权 API 尚未配置。',
    );
  }

  let applicationOrigin: URL;
  let resolved: URL;
  try {
    applicationOrigin = new URL(origin);
    resolved = new URL(apiBaseUrl, applicationOrigin);
  } catch {
    throw new WorkBuddyAuthorizationClientError(
      'invalid_configuration',
      'WorkBuddy 授权 API 地址无效。',
    );
  }

  const validApplicationOrigin =
    applicationOrigin.protocol === 'https:' ||
    (applicationOrigin.protocol === 'http:' && isLoopback(applicationOrigin.hostname));
  if (
    !validApplicationOrigin ||
    resolved.origin !== applicationOrigin.origin ||
    resolved.username.length > 0 ||
    resolved.password.length > 0 ||
    resolved.search.length > 0 ||
    resolved.hash.length > 0
  ) {
    throw new WorkBuddyAuthorizationClientError(
      'invalid_configuration',
      'WorkBuddy 授权 API 必须使用当前站点的安全同源地址。',
    );
  }

  resolved.pathname = `${resolved.pathname.replace(/\/$/u, '')}/`;
  return resolved;
}

async function responseError(response: Response): Promise<WorkBuddyAuthorizationClientError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const parsed = apiErrorEnvelopeSchema.strict().safeParse(payload);
  const trustedError =
    parsed.success &&
    Object.keys(parsed.data.error).every((key) =>
      ['code', 'details', 'message', 'retryable'].includes(key),
    )
      ? parsed.data
      : undefined;
  const code = trustedError?.error.code;
  const requestId = trustedError?.request_id;
  const retryable = trustedError?.error.retryable ?? response.status >= 500;

  if (response.status === 403 || code === 'FORBIDDEN') {
    return new WorkBuddyAuthorizationClientError(
      'forbidden',
      '安全校验未通过，请刷新页面后重试。',
      false,
      requestId,
    );
  }
  if (response.status === 409 || code === 'CONFLICT') {
    return new WorkBuddyAuthorizationClientError(
      'transaction_expired',
      '本次授权事务已失效，请重新开始。',
      false,
      requestId,
    );
  }
  if (response.status === 400 || code === 'BAD_REQUEST') {
    return new WorkBuddyAuthorizationClientError(
      'invalid_request',
      '授权请求无效，页面不会继续使用该状态。',
      false,
      requestId,
    );
  }
  if (response.status === 503 || code === 'SERVICE_UNAVAILABLE') {
    return new WorkBuddyAuthorizationClientError(
      'unavailable',
      'WorkBuddy 授权服务尚未就绪。',
      retryable,
      requestId,
    );
  }
  return new WorkBuddyAuthorizationClientError(
    'unavailable',
    '无法确认 WorkBuddy 授权状态。',
    retryable,
    requestId,
  );
}

async function parseResult(response: Response): Promise<WorkBuddyAuthorizationResult> {
  if (!response.ok) throw await responseError(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WorkBuddyAuthorizationClientError(
      'invalid_response',
      '授权服务返回了无法识别的状态。',
    );
  }
  const parsed = apiSuccessEnvelopeSchema(workBuddyAuthorizationResultSchema)
    .strict()
    .safeParse(payload);
  if (!parsed.success) {
    throw new WorkBuddyAuthorizationClientError(
      'invalid_response',
      '授权服务返回了无法识别的状态。',
    );
  }
  return parsed.data.data;
}

export function readWorkBuddyCsrfToken(cookieHeader: string): string | undefined {
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (name !== '__Host-h5cs-csrf' && name !== 'h5cs_csrf') continue;
    const value = entry.slice(separator + 1).trim();
    return csrfTokenPattern.test(value) ? value : undefined;
  }
  return undefined;
}

export function createWorkBuddyAuthorizationApiClient(
  options: ClientOptions,
): WorkBuddyAuthorizationApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(options.apiBaseUrl, options.origin);

  const request = async (input: {
    body?: unknown;
    mutation?: boolean;
    path: string;
  }): Promise<WorkBuddyAuthorizationResult> => {
    const endpoint = new URL(input.path.replace(/^\//u, ''), baseUrl);
    if (endpoint.origin !== new URL(options.origin).origin) {
      throw new WorkBuddyAuthorizationClientError(
        'invalid_configuration',
        'WorkBuddy 授权请求被同源策略阻止。',
      );
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (input.mutation === true) {
      const csrfToken = options.getCsrfToken();
      if (csrfToken === undefined || !csrfTokenPattern.test(csrfToken)) {
        throw new WorkBuddyAuthorizationClientError(
          'forbidden',
          '缺少有效的 CSRF 校验信息，授权操作已停止。',
        );
      }
      headers['Content-Type'] = 'application/json';
      headers['x-csrf-token'] = csrfToken;
    }

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: 'no-store',
        credentials: 'same-origin',
        headers,
        method: input.mutation === true ? 'POST' : 'GET',
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof WorkBuddyAuthorizationClientError) throw error;
      throw new WorkBuddyAuthorizationClientError(
        'unavailable',
        '无法连接 WorkBuddy 授权服务。',
        true,
      );
    }
    return parseResult(response);
  };

  return {
    completeCallback: (input) => {
      const query = workBuddyAuthorizationCallbackQuerySchema.parse(input);
      const parameters = new URLSearchParams(query);
      return request({ path: `auth/workbuddy/callback?${parameters.toString()}` });
    },
    readStatus: (transactionRef) => {
      const query = workBuddyAuthorizationStatusQuerySchema.parse({
        ...(transactionRef === undefined ? {} : { transaction_ref: transactionRef }),
      });
      const parameters = new URLSearchParams(
        query.transaction_ref === undefined ? {} : { transaction_ref: query.transaction_ref },
      );
      const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
      return request({ path: `auth/workbuddy/status${suffix}` });
    },
    recordConsent: ({ decision, transactionRef }) =>
      request({
        body: workBuddyConsentRequestSchema.parse({
          decision,
          transaction_ref: transactionRef,
        }),
        mutation: true,
        path: 'auth/workbuddy/consent',
      }),
    selectMerchant: ({ candidateRef, transactionRef }) =>
      request({
        body: workBuddyMerchantSelectionRequestSchema.parse({
          candidate_ref: candidateRef,
          transaction_ref: transactionRef,
        }),
        mutation: true,
        path: 'auth/workbuddy/merchant-selection',
      }),
    startAuthorization: () =>
      request({ body: {}, mutation: true, path: 'auth/workbuddy/authorizations' }),
  };
}
