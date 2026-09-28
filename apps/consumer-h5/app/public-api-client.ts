export type PublicAssistantUnavailableReason =
  'not_available' | 'paused' | 'api_unavailable' | 'invalid_response' | 'unsafe_configuration';

export type OnlinePublicAssistantSnapshot = Readonly<{
  aiDisclosure: true;
  assistantDisplayName: string;
  availability: 'online';
  businessScope: string;
  merchantDisplayName: string;
  publicAssistantId: string;
  releaseRef: string;
  welcomeMessage: string;
}>;

export type PublicAssistantLoadResult =
  | Readonly<{ status: 'online'; snapshot: OnlinePublicAssistantSnapshot }>
  | Readonly<{ reason: PublicAssistantUnavailableReason; status: 'unavailable' }>;

export type PublicSession = Readonly<{
  createdAt: string;
  releaseRef: string;
  sessionHandle: string;
  state: 'active';
}>;

export type PublicSessionHistory = Readonly<{
  session: PublicSession;
  snapshot: OnlinePublicAssistantSnapshot;
  messages: readonly PublicMessage[];
  activeTurn: Readonly<{
    turnId: string;
    clientMessageId: string;
    content: string;
  }> | null;
  hasEarlierMessages: boolean;
}>;

export type PublicMessage = Readonly<{
  clientMessageId?: string | undefined;
  content: string;
  createdAt: string;
  messageId: string;
  role: 'visitor' | 'assistant';
  sequence: number;
  sourceLabel?: string | undefined;
}>;

export type AcceptedTurn = Readonly<{
  eventsUrl: string;
  resultUrl: string;
  state: 'accepted';
  traceId: string;
  turnId: string;
}>;

export type TurnResult =
  | Readonly<{
      messages: readonly PublicMessage[];
      sessionHandle: string;
      state: 'accepted' | 'processing';
      traceId: string;
      turnId: string;
    }>
  | Readonly<{
      messages: readonly PublicMessage[];
      sessionHandle: string;
      state: 'completed';
      traceId: string;
      turnId: string;
    }>
  | Readonly<{
      error: Readonly<{ code: string; retryable: boolean }>;
      messages: readonly PublicMessage[];
      sessionHandle: string;
      state: 'failed';
      traceId: string;
      turnId: string;
    }>;

export class PublicApiClientError extends Error {
  public readonly kind:
    | 'unsafe_configuration'
    | 'invalid_input'
    | 'invalid_response'
    | 'unavailable'
    | 'request_failed';
  public readonly retryable: boolean;
  public readonly requestId: string | undefined;

  public constructor(
    kind: PublicApiClientError['kind'],
    message: string,
    options: { requestId?: string | undefined; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'PublicApiClientError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
  }
}

interface PublicApiClientOptions {
  apiBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  origin?: string | undefined;
}

export interface PublicAssistantApiClient {
  createSession(input: {
    publicSlug: string;
    sessionRequestId: string;
    snapshot: OnlinePublicAssistantSnapshot;
    signal?: AbortSignal | undefined;
  }): Promise<PublicSession>;
  endSession(input: { sessionHandle: string; signal?: AbortSignal | undefined }): Promise<boolean>;
  loadAssistant(
    publicSlug: string,
    signal?: AbortSignal | undefined,
  ): Promise<PublicAssistantLoadResult>;
  resumeSession(input: {
    publicSlug: string;
    sessionRequestId: string;
    signal?: AbortSignal | undefined;
  }): Promise<PublicSession | null>;
  loadHistory(input: {
    sessionHandle: string;
    signal?: AbortSignal | undefined;
  }): Promise<PublicSessionHistory | null>;
  readTurn(input: {
    clientMessageId: string;
    resultUrl: string;
    sessionHandle: string;
    signal?: AbortSignal | undefined;
    turnId: string;
  }): Promise<TurnResult>;
  streamTurn(input: {
    clientMessageId: string;
    eventsUrl: string;
    sessionHandle: string;
    signal?: AbortSignal | undefined;
    turnId: string;
  }): AsyncGenerator<TurnResult>;
  sendMessage(input: {
    clientMessageId: string;
    content: string;
    sessionHandle: string;
    signal?: AbortSignal | undefined;
  }): Promise<AcceptedTurn>;
}

const publicSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62})$/u;
const opaqueRefPattern = /^[A-Za-z0-9](?:[A-Za-z0-9:_-]{0,190})$/u;
const clientIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{15,127})$/u;
const sessionRequestPattern = /^session_request_[0-9a-f]{32}$/u;
const sessionHandlePattern = /^s_[0-9a-f]{32}$/u;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
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

function boundedParagraph(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  return normalized.length > 0 &&
    normalized.length <= maximumLength &&
    !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function opaqueRef(value: unknown): string | undefined {
  const normalized = boundedText(value, 191);
  return normalized !== undefined && opaqueRefPattern.test(normalized) ? normalized : undefined;
}

function sessionHandleRef(value: unknown): string | undefined {
  return typeof value === 'string' && sessionHandlePattern.test(value) ? value : undefined;
}

function clientGeneratedId(value: unknown): string | undefined {
  const normalized = boundedText(value, 128);
  return normalized !== undefined && clientIdPattern.test(normalized) ? normalized : undefined;
}

function requestId(value: unknown): string | undefined {
  const normalized = boundedText(value, 128);
  return normalized !== undefined && requestIdPattern.test(normalized) ? normalized : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  const normalized = boundedText(value, 64);
  if (normalized === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u.test(normalized)) {
    return undefined;
  }
  return Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function decodeEnvelope(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['data', 'request_id'])) return undefined;
  return requestId(value['request_id']) === undefined || !isRecord(value['data'])
    ? undefined
    : value['data'];
}

export function decodePublicApiErrorEnvelope(
  value: unknown,
): Readonly<{ code: string; requestId: string; retryable: boolean }> | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['error', 'request_id'])) return undefined;
  const decodedRequestId = requestId(value['request_id']);
  const error = value['error'];
  if (
    decodedRequestId === undefined ||
    !isRecord(error) ||
    !hasExactKeys(error, ['code', 'message', 'retryable'], ['details']) ||
    typeof error['retryable'] !== 'boolean' ||
    opaqueRef(error['code']) === undefined ||
    boundedText(error['message'], 500) === undefined ||
    (error['details'] !== undefined && !isRecord(error['details']))
  ) {
    return undefined;
  }
  return {
    code: error['code'] as string,
    requestId: decodedRequestId,
    retryable: error['retryable'],
  };
}

function decodePublicAssistantSnapshotData(data: unknown):
  | Readonly<{
      aiDisclosure: true;
      assistantDisplayName: string;
      availability: 'online' | 'paused';
      businessScope: string;
      merchantDisplayName: string;
      publicAssistantId: string;
      releaseRef: string;
      welcomeMessage: string;
    }>
  | undefined {
  if (
    !isRecord(data) ||
    !hasExactKeys(data, [
      'publicAssistantId',
      'merchantDisplayName',
      'assistantDisplayName',
      'aiDisclosure',
      'businessScope',
      'welcomeMessage',
      'availability',
      'releaseRef',
    ]) ||
    data['aiDisclosure'] !== true ||
    (data['availability'] !== 'online' && data['availability'] !== 'paused')
  ) {
    return undefined;
  }
  const publicAssistantId = opaqueRef(data['publicAssistantId']);
  const merchantDisplayName = boundedText(data['merchantDisplayName'], 200);
  const assistantDisplayName = boundedText(data['assistantDisplayName'], 200);
  const businessScope = boundedParagraph(data['businessScope'], 2_000);
  const welcomeMessage = boundedParagraph(data['welcomeMessage'], 2_000);
  const releaseRef = opaqueRef(data['releaseRef']);
  if (
    publicAssistantId === undefined ||
    merchantDisplayName === undefined ||
    assistantDisplayName === undefined ||
    businessScope === undefined ||
    welcomeMessage === undefined ||
    releaseRef === undefined
  ) {
    return undefined;
  }
  return {
    aiDisclosure: true,
    assistantDisplayName,
    availability: data['availability'],
    businessScope,
    merchantDisplayName,
    publicAssistantId,
    releaseRef,
    welcomeMessage,
  };
}

export function decodePublicAssistantSnapshot(
  value: unknown,
): ReturnType<typeof decodePublicAssistantSnapshotData> {
  return decodePublicAssistantSnapshotData(decodeEnvelope(value));
}

export function decodePublicSession(value: unknown): PublicSession | undefined {
  const data = decodeEnvelope(value);
  if (
    data === undefined ||
    !hasExactKeys(data, ['sessionHandle', 'releaseRef', 'state', 'createdAt']) ||
    data['state'] !== 'active'
  ) {
    return undefined;
  }
  const sessionHandle = sessionHandleRef(data['sessionHandle']);
  const releaseRef = opaqueRef(data['releaseRef']);
  const createdAt = isoTimestamp(data['createdAt']);
  return sessionHandle === undefined || releaseRef === undefined || createdAt === undefined
    ? undefined
    : { createdAt, releaseRef, sessionHandle, state: 'active' };
}

function resolveTrustedPublicUrl(
  rawUrl: unknown,
  origin: URL,
  expectedPathPrefix: string,
): string | undefined {
  const value = boundedText(rawUrl, 2_048);
  if (value === undefined) return undefined;
  try {
    const url = new URL(value, origin);
    if (
      url.origin !== origin.origin ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0 ||
      url.search.length > 0 ||
      !url.pathname.startsWith(expectedPathPrefix)
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function decodeTurnEndpoint(
  value: string,
  kind: 'events' | 'result',
): Readonly<{ sessionHandle: string; turnId: string }> | undefined {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/');
    const expectedLength = kind === 'events' ? 9 : 8;
    if (
      segments.length !== expectedLength ||
      segments[1] !== 'api' ||
      segments[2] !== 'v1' ||
      segments[3] !== 'public' ||
      segments[4] !== 'sessions' ||
      segments[6] !== 'turns' ||
      (kind === 'events' && segments[8] !== 'events')
    ) {
      return undefined;
    }
    const sessionHandle = sessionHandleRef(decodeURIComponent(segments[5] ?? ''));
    const turnId = opaqueRef(decodeURIComponent(segments[7] ?? ''));
    return sessionHandle === undefined || turnId === undefined
      ? undefined
      : { sessionHandle, turnId };
  } catch {
    return undefined;
  }
}

export function decodeAcceptedTurn(value: unknown, origin: string): AcceptedTurn | undefined {
  const data = decodeEnvelope(value);
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return undefined;
  }
  if (
    data === undefined ||
    !hasExactKeys(data, ['turnId', 'state', 'eventsUrl', 'resultUrl', 'traceId']) ||
    data['state'] !== 'accepted'
  ) {
    return undefined;
  }
  const turnId = opaqueRef(data['turnId']);
  const traceId = opaqueRef(data['traceId']);
  const eventsUrl = resolveTrustedPublicUrl(data['eventsUrl'], parsedOrigin, '/api/v1/public/');
  const resultUrl = resolveTrustedPublicUrl(data['resultUrl'], parsedOrigin, '/api/v1/public/');
  const eventsEndpoint =
    eventsUrl === undefined ? undefined : decodeTurnEndpoint(eventsUrl, 'events');
  const resultEndpoint =
    resultUrl === undefined ? undefined : decodeTurnEndpoint(resultUrl, 'result');
  return turnId === undefined ||
    traceId === undefined ||
    eventsUrl === undefined ||
    resultUrl === undefined ||
    eventsEndpoint === undefined ||
    resultEndpoint === undefined ||
    eventsEndpoint.sessionHandle !== resultEndpoint.sessionHandle ||
    eventsEndpoint.turnId !== turnId ||
    resultEndpoint.turnId !== turnId
    ? undefined
    : { eventsUrl, resultUrl, state: 'accepted', traceId, turnId };
}

function decodePublicMessage(value: unknown): PublicMessage | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['messageId', 'sequence', 'role', 'content', 'createdAt'],
      ['clientMessageId', 'sourceLabel'],
    ) ||
    (value['role'] !== 'visitor' && value['role'] !== 'assistant') ||
    !Number.isSafeInteger(value['sequence']) ||
    (value['sequence'] as number) < 1
  ) {
    return undefined;
  }
  const messageId = opaqueRef(value['messageId']);
  const content = boundedParagraph(value['content'], 8_000);
  const createdAt = isoTimestamp(value['createdAt']);
  const clientMessageId =
    value['clientMessageId'] === undefined
      ? undefined
      : clientGeneratedId(value['clientMessageId']);
  const sourceLabel =
    value['sourceLabel'] === undefined ? undefined : boundedText(value['sourceLabel'], 80);
  if (
    messageId === undefined ||
    content === undefined ||
    createdAt === undefined ||
    (value['clientMessageId'] !== undefined && clientMessageId === undefined) ||
    (value['sourceLabel'] !== undefined && sourceLabel === undefined) ||
    (value['role'] === 'assistant' && clientMessageId !== undefined) ||
    (value['role'] === 'visitor' && sourceLabel !== undefined)
  ) {
    return undefined;
  }
  return {
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
    content,
    createdAt,
    messageId,
    role: value['role'],
    sequence: value['sequence'] as number,
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
  };
}

function decodeMessages(value: unknown): readonly PublicMessage[] | undefined {
  if (!Array.isArray(value) || value.length > 200) return undefined;
  const messages = value.map(decodePublicMessage);
  if (messages.some((message) => message === undefined)) return undefined;
  const decoded = messages as PublicMessage[];
  for (let index = 1; index < decoded.length; index += 1) {
    if (decoded[index - 1]!.sequence >= decoded[index]!.sequence) return undefined;
  }
  return new Set(decoded.map((message) => message.messageId)).size === decoded.length
    ? decoded
    : undefined;
}

export function decodePublicSessionHistory(value: unknown): PublicSessionHistory | undefined {
  const data = decodeEnvelope(value);
  if (
    data === undefined ||
    !hasExactKeys(data, [
      'sessionHandle',
      'releaseRef',
      'createdAt',
      'snapshot',
      'messages',
      'activeTurn',
      'hasEarlierMessages',
    ]) ||
    typeof data['hasEarlierMessages'] !== 'boolean'
  )
    return undefined;
  const session = decodePublicSession({
    data: {
      sessionHandle: data['sessionHandle'],
      releaseRef: data['releaseRef'],
      createdAt: data['createdAt'],
      state: 'active',
    },
    request_id: 'history.decode',
  });
  const snapshot = decodePublicAssistantSnapshotData(data['snapshot']);
  const messages = decodeMessages(data['messages']);
  if (
    !session ||
    !snapshot ||
    snapshot.availability !== 'online' ||
    !messages ||
    session.releaseRef !== snapshot.releaseRef
  )
    return undefined;
  const active = data['activeTurn'];
  if (active === null)
    return {
      session,
      snapshot: { ...snapshot, availability: 'online' },
      messages,
      activeTurn: null,
      hasEarlierMessages: data['hasEarlierMessages'],
    };
  if (!isRecord(active) || !hasExactKeys(active, ['turnId', 'clientMessageId', 'content'])) {
    return undefined;
  }
  const turnId = opaqueRef(active['turnId']);
  const clientMessageId = clientGeneratedId(active['clientMessageId']);
  const content = boundedParagraph(active['content'], 2_000);
  if (
    !turnId ||
    !clientMessageId ||
    !content ||
    !messages.some(
      (message) =>
        message.role === 'visitor' &&
        message.clientMessageId === clientMessageId &&
        message.content === content,
    )
  )
    return undefined;
  return {
    session,
    snapshot: { ...snapshot, availability: 'online' },
    messages,
    activeTurn: { turnId, clientMessageId, content },
    hasEarlierMessages: data['hasEarlierMessages'],
  };
}

function decodeTurnResultData(data: unknown): TurnResult | undefined {
  if (
    !isRecord(data) ||
    !hasExactKeys(data, ['sessionHandle', 'turnId', 'state', 'traceId', 'messages'], ['error']) ||
    (data['state'] !== 'accepted' &&
      data['state'] !== 'processing' &&
      data['state'] !== 'completed' &&
      data['state'] !== 'failed')
  ) {
    return undefined;
  }
  const sessionHandle = sessionHandleRef(data['sessionHandle']);
  const turnId = opaqueRef(data['turnId']);
  const traceId = opaqueRef(data['traceId']);
  const messages = decodeMessages(data['messages']);
  if (
    sessionHandle === undefined ||
    turnId === undefined ||
    traceId === undefined ||
    messages === undefined
  ) {
    return undefined;
  }
  if (data['state'] !== 'failed') {
    if (data['error'] !== undefined) return undefined;
    return { messages, sessionHandle, state: data['state'], traceId, turnId };
  }
  if (
    !isRecord(data['error']) ||
    !hasExactKeys(data['error'], ['code', 'retryable']) ||
    typeof data['error']['retryable'] !== 'boolean'
  ) {
    return undefined;
  }
  const code = opaqueRef(data['error']['code']);
  return code === undefined
    ? undefined
    : {
        error: { code, retryable: data['error']['retryable'] },
        messages,
        sessionHandle,
        state: 'failed',
        traceId,
        turnId,
      };
}

export function decodeTurnResult(value: unknown): TurnResult | undefined {
  return decodeTurnResultData(decodeEnvelope(value));
}

function resolveApiBaseUrl(apiBaseUrl: string | undefined, origin: string | undefined): URL {
  if (apiBaseUrl === undefined || origin === undefined) {
    throw new PublicApiClientError('unsafe_configuration', '公开客服服务尚未配置。');
  }
  try {
    const applicationOrigin = new URL(origin);
    const resolved = new URL(apiBaseUrl, applicationOrigin);
    const isLoopback =
      applicationOrigin.hostname === 'localhost' ||
      applicationOrigin.hostname === '127.0.0.1' ||
      applicationOrigin.hostname === '[::1]';
    if (
      (applicationOrigin.protocol !== 'https:' &&
        !(applicationOrigin.protocol === 'http:' && isLoopback)) ||
      applicationOrigin.pathname !== '/' ||
      applicationOrigin.search.length > 0 ||
      applicationOrigin.hash.length > 0 ||
      resolved.origin !== applicationOrigin.origin ||
      resolved.username.length > 0 ||
      resolved.password.length > 0 ||
      resolved.search.length > 0 ||
      resolved.hash.length > 0 ||
      !resolved.pathname.endsWith('/api/v1/public')
    ) {
      throw new Error('unsafe');
    }
    resolved.pathname = `${resolved.pathname.replace(/\/$/u, '')}/`;
    return resolved;
  } catch {
    throw new PublicApiClientError(
      'unsafe_configuration',
      '公开客服服务必须使用当前站点的同源地址。',
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > 512_000) return undefined;
    const text = await response.text();
    if (text.length === 0 || text.length > 512_000) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readFailureOptions(
  response: Response,
  fallbackRetryable: boolean,
): Promise<{ requestId?: string | undefined; retryable: boolean }> {
  const decoded = decodePublicApiErrorEnvelope(await readJson(response));
  return decoded === undefined
    ? { retryable: fallbackRetryable }
    : { requestId: decoded.requestId, retryable: decoded.retryable };
}

function decodeTurnEvent(
  frame: string,
  expected: { clientMessageId: string; sessionHandle: string; turnId: string },
): TurnResult | null {
  if (frame.startsWith(':')) return null;
  const lines = frame.split('\n');
  if (lines.length !== 2 || !lines[0]?.startsWith('event: ') || !lines[1]?.startsWith('data: ')) {
    throw new PublicApiClientError('invalid_response', '咨询事件格式无效。');
  }
  const eventName = lines[0].slice(7);
  if (eventName === 'unavailable') {
    throw new PublicApiClientError('unavailable', '实时更新暂不可用。', { retryable: true });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(lines[1].slice(6)) as unknown;
  } catch {
    throw new PublicApiClientError('invalid_response', '咨询事件内容无效。');
  }
  const result = decodeTurnResultData(payload);
  if (
    !result ||
    result.state !== eventName ||
    result.sessionHandle !== expected.sessionHandle ||
    result.turnId !== expected.turnId ||
    !result.messages.some(
      (message) =>
        message.role === 'visitor' && message.clientMessageId === expected.clientMessageId,
    )
  ) {
    throw new PublicApiClientError('invalid_response', '咨询事件与当前消息不匹配。');
  }
  return result;
}

export function createPublicAssistantApiClient(
  options: PublicApiClientOptions,
): PublicAssistantApiClient {
  const baseUrl = resolveApiBaseUrl(options.apiBaseUrl, options.origin);
  const origin = baseUrl.origin;
  const fetchImpl = options.fetchImpl ?? fetch;

  const endpointFor = (relativePath: string): URL => {
    const endpoint = new URL(relativePath.replace(/^\//u, ''), baseUrl);
    if (endpoint.origin !== origin || !endpoint.pathname.startsWith(baseUrl.pathname)) {
      throw new PublicApiClientError('unsafe_configuration', '公开客服请求地址无效。');
    }
    return endpoint;
  };

  return {
    async loadAssistant(publicSlug, signal) {
      if (!publicSlugPattern.test(publicSlug)) {
        return { reason: 'not_available', status: 'unavailable' };
      }
      let response: Response;
      try {
        response = await fetchImpl(endpointFor(`assistants/${encodeURIComponent(publicSlug)}`), {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          method: 'GET',
          redirect: 'error',
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        return { reason: 'api_unavailable', status: 'unavailable' };
      }
      if (response.status === 404) return { reason: 'not_available', status: 'unavailable' };
      if (response.status !== 200) return { reason: 'api_unavailable', status: 'unavailable' };
      const decoded = decodePublicAssistantSnapshot(await readJson(response));
      if (decoded === undefined) return { reason: 'invalid_response', status: 'unavailable' };
      if (decoded.availability === 'paused') {
        return { reason: 'paused', status: 'unavailable' };
      }
      return { snapshot: { ...decoded, availability: 'online' }, status: 'online' };
    },

    async createSession({ publicSlug, sessionRequestId, snapshot, signal }) {
      if (
        !sessionRequestPattern.test(sessionRequestId) ||
        !publicSlugPattern.test(publicSlug) ||
        snapshot.availability !== 'online'
      ) {
        throw new PublicApiClientError('invalid_input', '无法创建公开咨询会话。');
      }
      let response: Response;
      try {
        response = await fetchImpl(
          endpointFor(`assistants/${encodeURIComponent(publicSlug)}/sessions`),
          {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: {
              Accept: 'application/json',
              'Idempotency-Key': sessionRequestId,
            },
            method: 'POST',
            redirect: 'error',
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch {
        throw new PublicApiClientError('unavailable', '无法连接咨询服务。', { retryable: true });
      }
      if (response.status !== 201) {
        const options = await readFailureOptions(response, response.status >= 500);
        throw new PublicApiClientError('request_failed', '服务端未确认创建咨询会话。', {
          ...options,
        });
      }
      const session = decodePublicSession(await readJson(response));
      if (session === undefined || session.releaseRef !== snapshot.releaseRef) {
        throw new PublicApiClientError('invalid_response', '服务端返回了无效的咨询会话。');
      }
      return session;
    },

    async resumeSession({ publicSlug, sessionRequestId, signal }) {
      if (!publicSlugPattern.test(publicSlug) || !sessionRequestPattern.test(sessionRequestId)) {
        throw new PublicApiClientError('invalid_input', '恢复咨询会话的参数无效。');
      }
      let response: Response;
      try {
        response = await fetchImpl(
          endpointFor(`assistants/${encodeURIComponent(publicSlug)}/sessions/${sessionRequestId}`),
          {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            method: 'GET',
            redirect: 'error',
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch {
        throw new PublicApiClientError('unavailable', '无法恢复咨询会话。', { retryable: true });
      }
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new PublicApiClientError('request_failed', '无法确认原咨询会话。', {
          ...(await readFailureOptions(response, response.status >= 500)),
        });
      }
      const session = decodePublicSession(await readJson(response));
      if (!session) throw new PublicApiClientError('invalid_response', '会话恢复结果无效。');
      return session;
    },

    async loadHistory({ sessionHandle, signal }) {
      if (sessionHandleRef(sessionHandle) === undefined) {
        throw new PublicApiClientError('invalid_input', '咨询会话标识无效。');
      }
      let response: Response;
      try {
        response = await fetchImpl(
          endpointFor(`sessions/${encodeURIComponent(sessionHandle)}/history`),
          {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            method: 'GET',
            redirect: 'error',
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch {
        throw new PublicApiClientError('unavailable', '无法读取咨询记录。', { retryable: true });
      }
      if (response.status === 404) return null;
      if (response.status !== 200) {
        throw new PublicApiClientError('request_failed', '咨询记录暂不可用。', {
          ...(await readFailureOptions(response, response.status >= 500)),
        });
      }
      const history = decodePublicSessionHistory(await readJson(response));
      if (!history || history.session.sessionHandle !== sessionHandle) {
        throw new PublicApiClientError('invalid_response', '咨询记录与当前会话不匹配。');
      }
      return history;
    },

    async endSession({ sessionHandle, signal }) {
      if (sessionHandleRef(sessionHandle) === undefined) {
        throw new PublicApiClientError('invalid_input', '咨询会话标识无效。');
      }
      let response: Response;
      try {
        response = await fetchImpl(endpointFor(`sessions/${sessionHandle}/end`), {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          method: 'POST',
          redirect: 'error',
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new PublicApiClientError('unavailable', '无法结束原咨询，请重试。', {
          retryable: true,
        });
      }
      if (response.status === 404) return false;
      if (response.status !== 200) {
        throw new PublicApiClientError('request_failed', '服务端未确认结束原咨询。', {
          ...(await readFailureOptions(response, response.status >= 500)),
        });
      }
      const data = decodeEnvelope(await readJson(response));
      if (
        !data ||
        !hasExactKeys(data, ['sessionHandle', 'state']) ||
        data['sessionHandle'] !== sessionHandle ||
        data['state'] !== 'ended'
      ) {
        throw new PublicApiClientError('invalid_response', '结束咨询结果无效。');
      }
      return true;
    },

    async sendMessage({ clientMessageId, content, sessionHandle, signal }) {
      const normalizedContent = content.trim();
      if (
        !clientIdPattern.test(clientMessageId) ||
        sessionHandleRef(sessionHandle) === undefined ||
        normalizedContent.length === 0 ||
        normalizedContent.length > 2_000
      ) {
        throw new PublicApiClientError('invalid_input', '咨询消息格式无效。');
      }
      let response: Response;
      try {
        response = await fetchImpl(
          endpointFor(`sessions/${encodeURIComponent(sessionHandle)}/messages`),
          {
            body: JSON.stringify({ clientMessageId, content: normalizedContent }),
            cache: 'no-store',
            credentials: 'same-origin',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'Idempotency-Key': clientMessageId,
            },
            method: 'POST',
            redirect: 'error',
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch {
        throw new PublicApiClientError('unavailable', '消息发送失败，请重试。', {
          retryable: true,
        });
      }
      if (response.status !== 202) {
        const options = await readFailureOptions(
          response,
          response.status >= 500 || response.status === 408 || response.status === 429,
        );
        throw new PublicApiClientError('request_failed', '服务端未确认消息发送。', {
          ...options,
        });
      }
      const accepted = decodeAcceptedTurn(await readJson(response), origin);
      if (accepted === undefined) {
        throw new PublicApiClientError('invalid_response', '服务端返回了无效的消息状态。');
      }
      return accepted;
    },

    async *streamTurn({ clientMessageId, eventsUrl, sessionHandle, signal, turnId }) {
      const safeUrl = resolveTrustedPublicUrl(eventsUrl, baseUrl, '/api/v1/public/');
      const endpoint = safeUrl === undefined ? undefined : decodeTurnEndpoint(safeUrl, 'events');
      if (
        safeUrl === undefined ||
        endpoint?.sessionHandle !== sessionHandle ||
        endpoint.turnId !== turnId ||
        !clientIdPattern.test(clientMessageId) ||
        sessionHandleRef(sessionHandle) === undefined ||
        opaqueRef(turnId) === undefined
      ) {
        throw new PublicApiClientError('invalid_input', '咨询事件地址无效。');
      }
      let response: Response;
      try {
        response = await fetchImpl(safeUrl, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'text/event-stream' },
          method: 'GET',
          redirect: 'error',
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new PublicApiClientError('unavailable', '实时更新暂不可用。', { retryable: true });
      }
      if (
        response.status !== 200 ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
        !response.body
      ) {
        throw new PublicApiClientError('unavailable', '实时更新暂不可用。', { retryable: true });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll(
            '\r\n',
            '\n',
          );
          if (buffer.length > 262_144) {
            throw new PublicApiClientError('invalid_response', '咨询事件过长。');
          }
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const result = decodeTurnEvent(frame, { clientMessageId, sessionHandle, turnId });
            if (result) {
              yield result;
              if (result.state === 'completed' || result.state === 'failed') return;
            }
            end = buffer.indexOf('\n\n');
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      throw new PublicApiClientError('unavailable', '实时更新已中断。', { retryable: true });
    },

    async readTurn({ clientMessageId, resultUrl, sessionHandle, signal, turnId }) {
      const safeUrl = resolveTrustedPublicUrl(resultUrl, baseUrl, '/api/v1/public/');
      const resultEndpoint =
        safeUrl === undefined ? undefined : decodeTurnEndpoint(safeUrl, 'result');
      if (
        safeUrl === undefined ||
        resultEndpoint === undefined ||
        resultEndpoint.sessionHandle !== sessionHandle ||
        resultEndpoint.turnId !== turnId ||
        !clientIdPattern.test(clientMessageId) ||
        sessionHandleRef(sessionHandle) === undefined ||
        opaqueRef(turnId) === undefined
      ) {
        throw new PublicApiClientError('invalid_input', '消息结果地址无效。');
      }
      let response: Response;
      try {
        response = await fetchImpl(safeUrl, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          method: 'GET',
          redirect: 'error',
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new PublicApiClientError('unavailable', '无法确认消息结果。', { retryable: true });
      }
      if (response.status !== 200) {
        const options = await readFailureOptions(response, response.status >= 500);
        throw new PublicApiClientError('request_failed', '服务端未返回消息结果。', {
          ...options,
        });
      }
      const result = decodeTurnResult(await readJson(response));
      const visitorMessage = result?.messages.find(
        (message) => message.role === 'visitor' && message.clientMessageId === clientMessageId,
      );
      if (
        result === undefined ||
        result.sessionHandle !== sessionHandle ||
        result.turnId !== turnId ||
        visitorMessage === undefined
      ) {
        throw new PublicApiClientError('invalid_response', '服务端返回了不匹配的消息结果。');
      }
      return result;
    },
  };
}

export async function loadPublicAssistantSnapshot(input: {
  apiBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  origin?: string | undefined;
  publicSlug: string;
}): Promise<PublicAssistantLoadResult> {
  try {
    return await createPublicAssistantApiClient(input).loadAssistant(input.publicSlug);
  } catch (error) {
    return {
      reason:
        error instanceof PublicApiClientError && error.kind === 'unsafe_configuration'
          ? 'unsafe_configuration'
          : 'api_unavailable',
      status: 'unavailable',
    };
  }
}
