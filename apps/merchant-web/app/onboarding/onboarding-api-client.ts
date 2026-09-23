import {
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  onboardingEventRequestSchema,
  skillIntentRequestSchema,
  skillIntentResultSchema,
  type SkillIntentResult,
} from '@h5cs/contracts';

type ContinueOnboardingResult = Extract<SkillIntentResult, { action: 'continue_onboarding' }>;
export type ExistingAssistantResult = Extract<
  SkillIntentResult,
  { action: 'open_management_console' | 'select_assistant' }
>;
export type OnboardingStartResult = ContinueOnboardingResult | ExistingAssistantResult;

export type PricingAvailability = 'provided' | 'none_confirmed' | 'unknown';
export type InsufficientFactPolicy = 'say_unconfirmed' | 'collect_lead' | 'contact_merchant';

export type OnboardingEventPayload =
  | { type: 'provide_industry'; industryCode: string }
  | {
      type: 'provide_materials';
      businessName: string;
      businessDescription: string;
      offerings: Array<{
        kind: 'product' | 'goods' | 'service';
        name: string;
        description: string;
        targetAudience: string;
      }>;
      materials: Array<{
        kind: 'faq' | 'text' | 'pdf' | 'other';
        reference: string;
        summary: string;
      }>;
    }
  | {
      type: 'provide_policy';
      pricingPolicy: {
        availability: PricingAvailability;
        facts: Array<{
          offeringName: string;
          amount: string;
          currency: string;
          conditions?: string;
        }>;
      };
      promotionPolicy: {
        availability: PricingAvailability;
        facts: Array<{
          name: string;
          description: string;
          conditions?: string;
        }>;
      };
      insufficientFactPolicy: InsufficientFactPolicy;
    }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'resume' };

export type OnboardingClientErrorKind =
  | 'not_configured'
  | 'unsafe_configuration'
  | 'authentication_required'
  | 'authentication_expired'
  | 'binding_required'
  | 'merchant_selection_required'
  | 'conflict'
  | 'generation_unavailable'
  | 'unavailable'
  | 'invalid_response'
  | 'request_failed';

export class OnboardingClientError extends Error {
  public readonly kind: OnboardingClientErrorKind;
  public readonly requestId: string | undefined;
  public readonly retryable: boolean;

  public constructor(
    kind: OnboardingClientErrorKind,
    message: string,
    options: { requestId?: string | undefined; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'OnboardingClientError';
    this.kind = kind;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
  }
}

export interface OnboardingApiClient {
  advance(input: {
    event: OnboardingEventPayload;
    idempotencyKey: string;
    revision?: string;
    sessionId: string;
  }): Promise<ContinueOnboardingResult>;
  startOrResume(input: {
    idempotencyKey: string;
    resumeSessionId?: string;
  }): Promise<OnboardingStartResult>;
  openManagement(input: {
    assistantRef: string;
    idempotencyKey: string;
  }): Promise<ExistingAssistantResult>;
}

interface ClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  getAccessToken: () => string | undefined;
  origin: string;
  onAuthenticationExpired?: () => void;
}

function resolveBaseUrl(apiBaseUrl: string | undefined, origin: string): URL {
  if (apiBaseUrl === undefined || apiBaseUrl.trim().length === 0) {
    throw new OnboardingClientError('not_configured', '管理 API 尚未配置。');
  }

  let applicationOrigin: URL;
  let resolved: URL;
  try {
    applicationOrigin = new URL(origin);
    resolved = new URL(apiBaseUrl, applicationOrigin);
  } catch {
    throw new OnboardingClientError('unsafe_configuration', '管理 API 地址无效。');
  }

  if (
    resolved.origin !== applicationOrigin.origin ||
    resolved.username.length > 0 ||
    resolved.password.length > 0 ||
    resolved.search.length > 0 ||
    resolved.hash.length > 0
  ) {
    throw new OnboardingClientError(
      'unsafe_configuration',
      '管理 API 必须使用当前站点的同源地址。',
    );
  }

  resolved.pathname = `${resolved.pathname.replace(/\/$/u, '')}/`;
  return resolved;
}

function parseContinueResult(payload: unknown): ContinueOnboardingResult {
  const rawEnvelope = record(payload);
  const rawData = rawEnvelope === undefined ? undefined : record(rawEnvelope['data']);
  const rawMissingItems = rawData?.['missing_items'];
  const parsed = apiSuccessEnvelopeSchema(skillIntentResultSchema).strict().safeParse(payload);
  if (
    rawEnvelope === undefined ||
    !exactKeys(rawEnvelope, ['data', 'request_id']) ||
    rawData === undefined ||
    !exactKeys(rawData, ['action', 'missing_items', 'onboarding_session_id', 'state']) ||
    !Array.isArray(rawMissingItems) ||
    rawMissingItems.some((item) => {
      const rawItem = record(item);
      return rawItem === undefined || !exactKeys(rawItem, ['code', 'message']);
    }) ||
    !parsed.success ||
    parsed.data.data.action !== 'continue_onboarding' ||
    !exactKeys(parsed.data.data, ['action', 'missing_items', 'onboarding_session_id', 'state'])
  ) {
    throw new OnboardingClientError('invalid_response', '服务端未返回有效的引导状态。');
  }
  return parsed.data.data;
}

function parseStartResult(payload: unknown, origin: string): OnboardingStartResult {
  const rawEnvelope = record(payload);
  const rawData = rawEnvelope === undefined ? undefined : record(rawEnvelope['data']);
  if (rawData?.['action'] === 'continue_onboarding') return parseContinueResult(payload);
  const parsed = apiSuccessEnvelopeSchema(skillIntentResultSchema).strict().safeParse(payload);
  if (
    rawEnvelope === undefined ||
    !exactKeys(rawEnvelope, ['data', 'request_id']) ||
    rawData === undefined ||
    !parsed.success ||
    (parsed.data.data.action !== 'open_management_console' &&
      parsed.data.data.action !== 'select_assistant')
  ) {
    throw new OnboardingClientError('invalid_response', '服务端未返回有效的客服管理入口。');
  }
  const result = parsed.data.data;
  const expectedKeys =
    result.action === 'open_management_console'
      ? ['action', 'assistant', 'url']
      : ['action', 'assistants', 'selection_required', 'url'];
  const assistantRecords =
    result.action === 'open_management_console' ? [rawData['assistant']] : rawData['assistants'];
  if (
    !exactKeys(rawData, expectedKeys) ||
    !Array.isArray(assistantRecords) ||
    assistantRecords.some((item) => {
      const assistant = record(item);
      return (
        assistant === undefined ||
        !exactKeys(assistant, ['assistant_ref', 'display_name', 'status'])
      );
    }) ||
    !safeManagementUrl(result.url, origin, result)
  ) {
    throw new OnboardingClientError('invalid_response', '服务端返回的管理入口未通过安全校验。');
  }
  return result;
}

function safeManagementUrl(
  value: string,
  origin: string,
  result: ExistingAssistantResult,
): boolean {
  try {
    const target = new URL(value);
    const application = new URL(origin);
    const safeOrigin =
      target.origin === application.origin &&
      target.username === '' &&
      target.password === '' &&
      target.search === '' &&
      target.hash === '';
    if (!safeOrigin) return false;
    if (result.action === 'select_assistant') {
      return /^\/workspace\/[0-9a-f]{32}$/u.test(target.pathname);
    }
    const match = /^\/workspace\/[0-9a-f]{32}\/assistants\/([0-9a-f]{32})$/u.exec(target.pathname);
    return match?.[1] === result.assistant.assistant_ref;
  } catch {
    return false;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function parseError(response: Response): Promise<OnboardingClientError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const rawEnvelope = record(body);
  const rawError = rawEnvelope === undefined ? undefined : record(rawEnvelope['error']);
  const parsed = apiErrorEnvelopeSchema.strict().safeParse(body);
  const trustedError =
    rawEnvelope !== undefined &&
    exactKeys(rawEnvelope, ['error', 'request_id']) &&
    rawError !== undefined &&
    exactKeys(rawError, [
      'code',
      ...(rawError['details'] === undefined ? [] : ['details']),
      'message',
      'retryable',
    ]) &&
    parsed.success &&
    exactKeys(parsed.data.error, [
      'code',
      ...(parsed.data.error.details === undefined ? [] : ['details']),
      'message',
      'retryable',
    ])
      ? parsed.data
      : undefined;
  const requestId = trustedError?.request_id;
  const code = trustedError?.error.code;
  const retryable = trustedError?.error.retryable ?? response.status >= 500;

  if (response.status === 401) {
    return new OnboardingClientError('authentication_expired', '登录已过期，请重新安全绑定。', {
      requestId,
    });
  }
  if (code === 'BINDING_REQUIRED') {
    return new OnboardingClientError('binding_required', '需要先完成安全商家绑定。', {
      requestId,
    });
  }
  if (code === 'MERCHANT_SELECTION_REQUIRED') {
    return new OnboardingClientError(
      'merchant_selection_required',
      '当前身份关联多个商家，需要先安全选择商家。',
      { requestId },
    );
  }
  if (code === 'GENERATION_UNAVAILABLE') {
    return new OnboardingClientError('generation_unavailable', '客服生成尚未接通或暂不可用。', {
      requestId,
      retryable,
    });
  }
  if (code === 'CONFLICT' || code === 'VERSION_CONFLICT') {
    return new OnboardingClientError('conflict', '服务端状态已变化，请刷新后重试。', {
      requestId,
    });
  }
  if (response.status === 503 || code === 'SERVICE_UNAVAILABLE') {
    return new OnboardingClientError('unavailable', '管理服务暂不可用。', {
      requestId,
      retryable,
    });
  }
  return new OnboardingClientError('request_failed', '请求未成功，服务端未确认保存。', {
    requestId,
    retryable,
  });
}

export function createOnboardingApiClient(options: ClientOptions): OnboardingApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  const request = async (
    relativePath: string,
    body: unknown,
    idempotencyKey: string,
    revision?: string,
  ): Promise<unknown> => {
    const baseUrl = resolveBaseUrl(options.apiBaseUrl, options.origin);
    const accessToken = options.getAccessToken();
    if (accessToken === undefined || accessToken.trim().length === 0) {
      throw new OnboardingClientError('authentication_required', '需要完成安全绑定后才能提交。');
    }

    const endpoint = new URL(relativePath.replace(/^\//u, ''), baseUrl);
    if (endpoint.origin !== new URL(options.origin).origin) {
      throw new OnboardingClientError('unsafe_configuration', '请求被同源策略阻止。');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    };
    if (revision !== undefined) headers['If-Match'] = revision;

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
        headers,
        method: 'POST',
      });
    } catch {
      throw new OnboardingClientError('unavailable', '无法连接管理服务。', {
        retryable: true,
      });
    }

    if (!response.ok) {
      const error = await parseError(response);
      if (error.kind === 'authentication_expired') options.onAuthenticationExpired?.();
      throw error;
    }

    return response.json();
  };

  return {
    advance: async ({ event, idempotencyKey, revision, sessionId }) => {
      const body = onboardingEventRequestSchema.parse({ event });
      return parseContinueResult(
        await request(
          `onboarding/${encodeURIComponent(sessionId)}/events`,
          body,
          idempotencyKey,
          revision,
        ),
      );
    },
    startOrResume: async ({ idempotencyKey, resumeSessionId }) => {
      const body = skillIntentRequestSchema.parse({
        intent: 'create_customer_service',
        ...(resumeSessionId === undefined ? {} : { resume_session_id: resumeSessionId }),
      });
      return parseStartResult(await request('intents', body, idempotencyKey), options.origin);
    },
    openManagement: async ({ assistantRef, idempotencyKey }) => {
      const body = skillIntentRequestSchema.parse({
        intent: 'open_management_console',
        assistant_ref: assistantRef,
      });
      const result = parseStartResult(
        await request('intents', body, idempotencyKey),
        options.origin,
      );
      if (
        result.action !== 'open_management_console' ||
        result.assistant.assistant_ref !== assistantRef
      ) {
        throw new OnboardingClientError('invalid_response', '服务端未确认所选客服。');
      }
      return result;
    },
  };
}
