export type ReleaseOperationState = 'accepted' | 'processing' | 'succeeded' | 'failed';

export type ReleaseOperation =
  | Readonly<{ operationId: string; state: 'accepted' | 'processing' }>
  | Readonly<{
      operationId: string;
      result: Readonly<{ publicUrl: string; releaseId: string; releaseNo: number }>;
      state: 'succeeded';
    }>
  | Readonly<{
      failure: Readonly<{ code: string; message: string; traceId?: string | undefined }>;
      operationId: string;
      state: 'failed';
    }>;

export interface AssistantDraftSnapshot {
  assistantRef: string;
  currentRelease: Readonly<{ activatedAt: string; releaseId: string; releaseNo: number }> | null;
  draft: Readonly<{
    assistantName: string;
    businessScope: string;
    industry: Readonly<{ code: string; label: string }> | null;
    insufficientInfoMessage: string;
    materialsSummary: string;
    pricingSummary: string;
    promotionSummary: string;
    revision: number;
    updatedAt: string;
    welcomeMessage: string;
  }>;
  etag: string;
  publication: ReleaseOperation | null;
  publishCheck: Readonly<{
    items: readonly Readonly<{
      code: string;
      level: 'blocked' | 'passed' | 'warning';
      message: string;
    }>[];
    state: 'blocked' | 'ready';
  }>;
}

export interface ReleaseAcceptedResult {
  operationId: string;
  pollUrl: string;
  releaseId: string;
  state: 'accepted';
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const opaqueReferencePattern = /^[A-Za-z0-9_-]{1,128}$/u;
const stableCodePattern = /^[a-z][a-z0-9_]{1,63}$/u;
const strongEtagPattern = /^"[A-Za-z0-9._:-]{1,128}"$/u;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function reference(value: unknown): string | undefined {
  return typeof value === 'string' && opaqueReferencePattern.test(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return value;
}

function decodeFailure(
  value: unknown,
): Extract<ReleaseOperation, { state: 'failed' }>['failure'] | undefined {
  const candidate = record(value);
  if (candidate === undefined || !hasExactKeys(candidate, ['code', 'message'], ['traceId'])) {
    return undefined;
  }
  const code = typeof candidate['code'] === 'string' ? candidate['code'] : undefined;
  const message = text(candidate['message'], 300);
  const traceId = candidate['traceId'] === undefined ? undefined : reference(candidate['traceId']);
  if (code === undefined || !stableCodePattern.test(code) || message === undefined)
    return undefined;
  if (candidate['traceId'] !== undefined && traceId === undefined) return undefined;
  return { code, message, ...(traceId === undefined ? {} : { traceId }) };
}

function decodeOperationResult(
  value: unknown,
): Extract<ReleaseOperation, { state: 'succeeded' }>['result'] | undefined {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, ['publicUrl', 'releaseId', 'releaseNo'])
  ) {
    return undefined;
  }
  const publicUrl = text(candidate['publicUrl'], 2_048);
  const releaseId = reference(candidate['releaseId']);
  const releaseNo = positiveInteger(candidate['releaseNo']);
  return publicUrl === undefined || releaseId === undefined || releaseNo === undefined
    ? undefined
    : { publicUrl, releaseId, releaseNo };
}

export function decodeReleaseOperation(value: unknown): ReleaseOperation | undefined {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, ['operationId', 'state'], ['failure', 'result'])
  ) {
    return undefined;
  }
  const operationId = reference(candidate['operationId']);
  const state = candidate['state'];
  if (
    operationId === undefined ||
    (state !== 'accepted' && state !== 'processing' && state !== 'succeeded' && state !== 'failed')
  ) {
    return undefined;
  }

  if (state === 'succeeded') {
    const result = decodeOperationResult(candidate['result']);
    return result === undefined || candidate['failure'] !== undefined
      ? undefined
      : { operationId, result, state };
  }
  if (state === 'failed') {
    const failure = decodeFailure(candidate['failure']);
    return failure === undefined || candidate['result'] !== undefined
      ? undefined
      : { failure, operationId, state };
  }
  if (candidate['failure'] !== undefined || candidate['result'] !== undefined) return undefined;
  return { operationId, state };
}

function decodeDraft(value: unknown): AssistantDraftSnapshot['draft'] | undefined {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, [
      'assistantName',
      'businessScope',
      'industry',
      'insufficientInfoMessage',
      'materialsSummary',
      'pricingSummary',
      'promotionSummary',
      'revision',
      'updatedAt',
      'welcomeMessage',
    ])
  ) {
    return undefined;
  }
  const assistantName = text(candidate['assistantName'], 80);
  const businessScope = text(candidate['businessScope'], 500);
  const insufficientInfoMessage = text(candidate['insufficientInfoMessage'], 500);
  const materialsSummary = text(candidate['materialsSummary'], 1_000);
  const pricingSummary = text(candidate['pricingSummary'], 500);
  const promotionSummary = text(candidate['promotionSummary'], 500);
  const revision = positiveInteger(candidate['revision']);
  const updatedAt = timestamp(candidate['updatedAt']);
  const welcomeMessage = text(candidate['welcomeMessage'], 500);
  const industryValue = candidate['industry'];
  let industry: AssistantDraftSnapshot['draft']['industry'];
  if (industryValue === null) {
    industry = null;
  } else {
    const industryRecord = record(industryValue);
    if (industryRecord === undefined || !hasExactKeys(industryRecord, ['code', 'label'])) {
      return undefined;
    }
    const code = text(industryRecord['code'], 80);
    const label = text(industryRecord['label'], 120);
    if (code === undefined || label === undefined) return undefined;
    industry = { code, label };
  }
  if (
    assistantName === undefined ||
    businessScope === undefined ||
    insufficientInfoMessage === undefined ||
    materialsSummary === undefined ||
    pricingSummary === undefined ||
    promotionSummary === undefined ||
    revision === undefined ||
    updatedAt === undefined ||
    welcomeMessage === undefined
  ) {
    return undefined;
  }
  return {
    assistantName,
    businessScope,
    industry,
    insufficientInfoMessage,
    materialsSummary,
    pricingSummary,
    promotionSummary,
    revision,
    updatedAt,
    welcomeMessage,
  };
}

function decodePublishCheck(value: unknown): AssistantDraftSnapshot['publishCheck'] | undefined {
  const candidate = record(value);
  if (candidate === undefined || !hasExactKeys(candidate, ['items', 'state'])) return undefined;
  const state = candidate['state'];
  if ((state !== 'blocked' && state !== 'ready') || !Array.isArray(candidate['items'])) {
    return undefined;
  }
  const items = candidate['items'].map((item) => {
    const itemRecord = record(item);
    if (itemRecord === undefined || !hasExactKeys(itemRecord, ['code', 'level', 'message'])) {
      return undefined;
    }
    const code = typeof itemRecord['code'] === 'string' ? itemRecord['code'] : undefined;
    const level = itemRecord['level'];
    const message = text(itemRecord['message'], 300);
    if (
      code === undefined ||
      !stableCodePattern.test(code) ||
      (level !== 'blocked' && level !== 'passed' && level !== 'warning') ||
      message === undefined
    ) {
      return undefined;
    }
    return { code, level, message } as const;
  });
  if (items.length > 50 || items.some((item) => item === undefined)) return undefined;
  if (state === 'ready' && items.some((item) => item?.level === 'blocked')) return undefined;
  return { items: items as NonNullable<(typeof items)[number]>[], state };
}

function decodeCurrentRelease(
  value: unknown,
): AssistantDraftSnapshot['currentRelease'] | undefined {
  if (value === null) return null;
  const candidate = record(value);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, ['activatedAt', 'releaseId', 'releaseNo'])
  ) {
    return undefined;
  }
  const activatedAt = timestamp(candidate['activatedAt']);
  const releaseId = reference(candidate['releaseId']);
  const releaseNo = positiveInteger(candidate['releaseNo']);
  return activatedAt === undefined || releaseId === undefined || releaseNo === undefined
    ? undefined
    : { activatedAt, releaseId, releaseNo };
}

export function decodeAssistantDraftSnapshot(value: unknown): AssistantDraftSnapshot | undefined {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, [
      'assistantRef',
      'currentRelease',
      'draft',
      'etag',
      'publication',
      'publishCheck',
    ])
  ) {
    return undefined;
  }
  const assistantRef = reference(candidate['assistantRef']);
  const currentRelease = decodeCurrentRelease(candidate['currentRelease']);
  const draft = decodeDraft(candidate['draft']);
  const etag =
    typeof candidate['etag'] === 'string' && strongEtagPattern.test(candidate['etag'])
      ? candidate['etag']
      : undefined;
  const publication =
    candidate['publication'] === null ? null : decodeReleaseOperation(candidate['publication']);
  const publishCheck = decodePublishCheck(candidate['publishCheck']);
  if (
    assistantRef === undefined ||
    currentRelease === undefined ||
    draft === undefined ||
    etag === undefined ||
    publication === undefined ||
    publishCheck === undefined
  ) {
    return undefined;
  }
  return { assistantRef, currentRelease, draft, etag, publication, publishCheck };
}

export function decodeReleaseAcceptedResult(value: unknown): ReleaseAcceptedResult | undefined {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !hasExactKeys(candidate, ['operationId', 'pollUrl', 'releaseId', 'state']) ||
    candidate['state'] !== 'accepted'
  ) {
    return undefined;
  }
  const operationId = reference(candidate['operationId']);
  const pollUrl = text(candidate['pollUrl'], 2_048);
  const releaseId = reference(candidate['releaseId']);
  return operationId === undefined || pollUrl === undefined || releaseId === undefined
    ? undefined
    : { operationId, pollUrl, releaseId, state: 'accepted' };
}

export function isSafeAssistantReference(value: string): boolean {
  return opaqueReferencePattern.test(value);
}
