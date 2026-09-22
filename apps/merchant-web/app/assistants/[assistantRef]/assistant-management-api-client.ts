import { apiErrorEnvelopeSchema, requestIdSchema } from '@h5cs/contracts';

import {
  decodeAssistantDraftSnapshot,
  decodeReleaseAcceptedResult,
  decodeReleaseOperation,
  isSafeAssistantReference,
  type AssistantDraftSnapshot,
  type ReleaseAcceptedResult,
  type ReleaseOperation,
} from './assistant-management-contract';

export type AssistantManagementClientErrorKind =
  | 'conflict'
  | 'forbidden'
  | 'invalid_configuration'
  | 'invalid_request'
  | 'invalid_response'
  | 'not_found'
  | 'unavailable';

export class AssistantManagementClientError extends Error {
  public constructor(
    public readonly kind: AssistantManagementClientErrorKind,
    message: string,
    public readonly retryable = false,
    public readonly requestId: string | undefined = undefined,
  ) {
    super(message);
    this.name = 'AssistantManagementClientError';
  }
}

export interface AssistantDraftUpdate {
  assistantName: string;
  businessScope: string;
  insufficientInfoMessage: string;
  welcomeMessage: string;
}

export interface AssistantManagementApiClient {
  loadSnapshot(): Promise<AssistantDraftSnapshot>;
  readOperation(operationId: string): Promise<ReleaseOperation>;
  saveDraft(input: {
    draft: AssistantDraftUpdate;
    etag: string;
    idempotencyKey: string;
  }): Promise<AssistantDraftSnapshot>;
  startRelease(input: {
    draftRevision: number;
    etag: string;
    idempotencyKey: string;
  }): Promise<ReleaseAcceptedResult>;
}

interface ClientOptions {
  apiBaseUrl?: string;
  assistantRef: string;
  fetchImpl?: typeof fetch;
  getCsrfToken: () => string | undefined;
  origin: string;
}

const csrfTokenPattern = /^[A-Za-z0-9_-]{32,512}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9_-]{16,128}$/u;
const strongEtagPattern = /^"[A-Za-z0-9._:-]{1,128}"$/u;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function resolveBaseUrl(apiBaseUrl: string | undefined, origin: string): URL {
  if (apiBaseUrl === undefined || apiBaseUrl.trim().length === 0) {
    throw new AssistantManagementClientError('invalid_configuration', '客服管理 API 尚未配置。');
  }
  let applicationOrigin: URL;
  let baseUrl: URL;
  try {
    applicationOrigin = new URL(origin);
    baseUrl = new URL(apiBaseUrl, applicationOrigin);
  } catch {
    throw new AssistantManagementClientError('invalid_configuration', '客服管理 API 地址无效。');
  }
  const secureOrigin =
    applicationOrigin.protocol === 'https:' ||
    (applicationOrigin.protocol === 'http:' && isLoopback(applicationOrigin.hostname));
  if (
    !secureOrigin ||
    baseUrl.origin !== applicationOrigin.origin ||
    baseUrl.username.length > 0 ||
    baseUrl.password.length > 0 ||
    baseUrl.search.length > 0 ||
    baseUrl.hash.length > 0
  ) {
    throw new AssistantManagementClientError(
      'invalid_configuration',
      '客服管理 API 必须使用当前站点的安全同源地址。',
    );
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/u, '')}/`;
  return baseUrl;
}

async function responseError(response: Response): Promise<AssistantManagementClientError> {
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
  if (response.status === 404 || code === 'NOT_FOUND') {
    return new AssistantManagementClientError(
      'not_found',
      '客服不存在或当前账号无权访问。',
      false,
      requestId,
    );
  }
  if (response.status === 403 || code === 'FORBIDDEN') {
    return new AssistantManagementClientError(
      'forbidden',
      '客服不存在或当前账号无权访问。',
      false,
      requestId,
    );
  }
  if (response.status === 409 || code === 'CONFLICT' || code === 'VERSION_CONFLICT') {
    return new AssistantManagementClientError(
      'conflict',
      '服务端草稿版本已经变化，请重新读取后再操作。',
      false,
      requestId,
    );
  }
  if (response.status === 400 || code === 'BAD_REQUEST') {
    return new AssistantManagementClientError(
      'invalid_request',
      '客服管理请求无效，服务端没有确认任何变更。',
      false,
      requestId,
    );
  }
  if (response.status === 503 || code === 'SERVICE_UNAVAILABLE') {
    return new AssistantManagementClientError(
      'unavailable',
      '客服管理服务尚未就绪。',
      retryable,
      requestId,
    );
  }
  return new AssistantManagementClientError(
    'unavailable',
    '无法确认客服管理操作结果。',
    retryable,
    requestId,
  );
}

function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => {
    throw new AssistantManagementClientError(
      'invalid_response',
      '客服管理服务返回了无法识别的数据。',
    );
  });
}

function decodeSuccessEnvelope<T>(
  value: unknown,
  decode: (data: unknown) => T | undefined,
): T | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const envelope = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(envelope);
  if (
    keys.length !== 2 ||
    !keys.includes('data') ||
    !keys.includes('request_id') ||
    !requestIdSchema.safeParse(envelope['request_id']).success
  ) {
    return undefined;
  }
  return decode(envelope['data']);
}

function readCsrfToken(options: ClientOptions): string {
  const token = options.getCsrfToken();
  if (token === undefined || !csrfTokenPattern.test(token)) {
    throw new AssistantManagementClientError(
      'forbidden',
      '缺少有效的 CSRF 校验信息，变更操作已停止。',
    );
  }
  return token;
}

export function readAssistantManagementCsrfToken(cookieHeader: string): string | undefined {
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

function mutationHeaders(options: ClientOptions, idempotencyKey: string, etag: string) {
  if (!idempotencyKeyPattern.test(idempotencyKey) || !strongEtagPattern.test(etag)) {
    throw new AssistantManagementClientError(
      'invalid_request',
      '幂等键或草稿版本无效，变更操作已停止。',
    );
  }
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'If-Match': etag,
    'x-csrf-token': readCsrfToken(options),
  };
}

function validateDraftUpdate(value: AssistantDraftUpdate): AssistantDraftUpdate {
  const keys = Object.keys(value);
  const expected = ['assistantName', 'businessScope', 'insufficientInfoMessage', 'welcomeMessage'];
  const validText = (field: keyof AssistantDraftUpdate, maximum: number) => {
    const text = value[field];
    const normalized = typeof text === 'string' ? text.trim() : '';
    return (
      normalized.length > 0 &&
      normalized.length <= maximum &&
      !/[\u0000-\u001F\u007F]/u.test(normalized)
    );
  };
  if (
    keys.length !== expected.length ||
    !expected.every((key) => keys.includes(key)) ||
    !validText('assistantName', 80) ||
    !validText('businessScope', 500) ||
    !validText('insufficientInfoMessage', 500) ||
    !validText('welcomeMessage', 500)
  ) {
    throw new AssistantManagementClientError('invalid_request', '草稿字段无效，变更操作已停止。');
  }
  return value;
}

export function createAssistantManagementApiClient(
  options: ClientOptions,
): AssistantManagementApiClient {
  if (!isSafeAssistantReference(options.assistantRef)) {
    throw new AssistantManagementClientError('invalid_request', '客服引用无效。');
  }
  const baseUrl = resolveBaseUrl(options.apiBaseUrl, options.origin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const assistantPath = `merchant/assistants/${encodeURIComponent(options.assistantRef)}`;

  const request = async (endpoint: URL, init: RequestInit): Promise<Response> => {
    if (endpoint.origin !== new URL(options.origin).origin) {
      throw new AssistantManagementClientError(
        'invalid_configuration',
        '客服管理请求被同源策略阻止。',
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        ...init,
      });
    } catch (error) {
      if (error instanceof AssistantManagementClientError) throw error;
      throw new AssistantManagementClientError(
        'unavailable',
        '无法连接客服管理服务，操作结果尚未确认。',
        true,
      );
    }
    if (!response.ok) throw await responseError(response);
    return response;
  };

  return {
    loadSnapshot: async () => {
      const response = await request(new URL(`${assistantPath}/draft`, baseUrl), {
        headers: { Accept: 'application/json' },
        method: 'GET',
      });
      const decoded = decodeSuccessEnvelope(
        await parseJson(response),
        decodeAssistantDraftSnapshot,
      );
      if (decoded === undefined || decoded.assistantRef !== options.assistantRef) {
        throw new AssistantManagementClientError(
          'invalid_response',
          '客服管理服务返回了不匹配的草稿。',
        );
      }
      return decoded;
    },
    readOperation: async (operationId) => {
      if (!isSafeAssistantReference(operationId)) {
        throw new AssistantManagementClientError('invalid_request', '发布操作引用无效。');
      }
      const response = await request(
        new URL(`merchant/operations/${encodeURIComponent(operationId)}`, baseUrl),
        { headers: { Accept: 'application/json' }, method: 'GET' },
      );
      const decoded = decodeSuccessEnvelope(await parseJson(response), decodeReleaseOperation);
      if (decoded === undefined || decoded.operationId !== operationId) {
        throw new AssistantManagementClientError(
          'invalid_response',
          '发布操作状态与当前操作不匹配。',
        );
      }
      return decoded;
    },
    saveDraft: async ({ draft, etag, idempotencyKey }) => {
      const response = await request(new URL(`${assistantPath}/draft`, baseUrl), {
        body: JSON.stringify(validateDraftUpdate(draft)),
        headers: mutationHeaders(options, idempotencyKey, etag),
        method: 'PATCH',
      });
      const decoded = decodeSuccessEnvelope(
        await parseJson(response),
        decodeAssistantDraftSnapshot,
      );
      if (decoded === undefined || decoded.assistantRef !== options.assistantRef) {
        throw new AssistantManagementClientError(
          'invalid_response',
          '服务端没有返回当前客服的新草稿版本。',
        );
      }
      return decoded;
    },
    startRelease: async ({ draftRevision, etag, idempotencyKey }) => {
      if (!Number.isSafeInteger(draftRevision) || draftRevision < 1) {
        throw new AssistantManagementClientError('invalid_request', '草稿 revision 无效。');
      }
      const response = await request(new URL(`${assistantPath}/releases`, baseUrl), {
        body: JSON.stringify({ activateWhenReady: true, draftRevision }),
        headers: mutationHeaders(options, idempotencyKey, etag),
        method: 'POST',
      });
      if (response.status !== 202) {
        throw new AssistantManagementClientError(
          'invalid_response',
          '发布请求未返回 202 Accepted。',
        );
      }
      const decoded = decodeSuccessEnvelope(await parseJson(response), decodeReleaseAcceptedResult);
      if (decoded === undefined) {
        throw new AssistantManagementClientError(
          'invalid_response',
          '发布请求未返回可恢复的操作引用。',
        );
      }
      const pollUrl = new URL(decoded.pollUrl, baseUrl);
      const expectedPollUrl = new URL(
        `merchant/operations/${encodeURIComponent(decoded.operationId)}`,
        baseUrl,
      );
      if (
        pollUrl.origin !== expectedPollUrl.origin ||
        pollUrl.pathname !== expectedPollUrl.pathname ||
        pollUrl.search.length > 0 ||
        pollUrl.hash.length > 0
      ) {
        throw new AssistantManagementClientError(
          'invalid_response',
          '发布请求返回了不安全的轮询地址。',
        );
      }
      return decoded;
    },
  };
}
