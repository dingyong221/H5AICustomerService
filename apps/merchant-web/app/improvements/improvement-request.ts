import type { ImprovementActionState } from './improvement-model';

export type ImprovementRequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ImprovementRequestRecord = Readonly<{
  key: string;
  fingerprint: string;
  values: Readonly<Record<string, string>>;
  outcome: 'pending' | 'unknown' | 'rejected';
}>;
const fields = [
  'question',
  'expectedAnswer',
  'reason',
  'notes',
  'sourceMessageId',
  'sourceSessionId',
  'runId',
  'verdict',
  'expectedVersion',
  'expectedDraftRevision',
] as const;
const contextFields = new Set<string>(['expectedVersion', 'expectedDraftRevision']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class UnknownImprovementRequest extends Error {
  constructor(
    message = '上次提交结果尚未确认，不能换一个请求重复创建。请先核对当前记录，或恢复上次内容后重试同一个请求。',
  ) {
    super(message);
    this.name = 'UnknownImprovementRequest';
  }
}

export function improvementRequestScope(input: {
  operation: string;
  merchantId: string;
  assistantId: string;
  improvementId?: string;
  sourceMessageId?: string;
  runId?: string;
}): string {
  return `h5cs:improvement-request:v1:${[input.operation, input.merchantId, input.assistantId, input.improvementId ?? 'new', input.sourceMessageId ?? 'manual', input.runId ?? 'none'].join(':')}`;
}

export function parseImprovementRequest(raw: string | null): ImprovementRequestRecord | null {
  if (raw === null) return null;
  try {
    if (raw.length > 30_000) throw new Error('invalid');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid');
    const record = parsed as Record<string, unknown>;
    if (
      typeof record['key'] !== 'string' ||
      !uuid.test(record['key']) ||
      typeof record['fingerprint'] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record['fingerprint']) ||
      !['pending', 'unknown', 'rejected'].includes(String(record['outcome'])) ||
      typeof record['values'] !== 'object' ||
      record['values'] === null ||
      Array.isArray(record['values'])
    )
      throw new Error('invalid');
    const values = record['values'] as Record<string, unknown>;
    if (
      Object.entries(values).some(
        ([name, value]) =>
          !fields.includes(name as (typeof fields)[number]) ||
          typeof value !== 'string' ||
          value.length > 8_000,
      )
    )
      throw new Error('invalid');
    return {
      key: record['key'],
      fingerprint: record['fingerprint'],
      values: values as Record<string, string>,
      outcome: record['outcome'] as ImprovementRequestRecord['outcome'],
    };
  } catch {
    throw new UnknownImprovementRequest(
      '本地请求记录无法读取。请先核对商家后台是否已经保存，勿反复提交；可在另一个正常窗口查看记录。',
    );
  }
}

/** Includes source identifiers, excludes credentials, consent, and CAS versions; versions are restored on unknown-result retries. */
export async function improvementInputFingerprint(
  values: Readonly<Record<string, string>>,
): Promise<string> {
  const semantic = Object.entries(values)
    .filter(([name]) => !contextFields.has(name))
    .sort(([left], [right]) => left.localeCompare(right));
  const bytes = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(semantic)),
  );
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function prepareImprovementRequest(input: {
  storage: ImprovementRequestStorage;
  scope: string;
  form: FormData;
  initialKey: string;
}): Promise<ImprovementRequestRecord> {
  const values: Record<string, string> = {};
  for (const name of fields) {
    const value = input.form.get(name);
    if (typeof value === 'string') values[name] = value;
  }
  const fingerprint = await improvementInputFingerprint(values);
  const previous = parseImprovementRequest(input.storage.getItem(input.scope));
  if (previous && previous.outcome !== 'rejected' && previous.fingerprint !== fingerprint)
    throw new UnknownImprovementRequest();
  const key = previous?.key ?? input.initialKey;
  if (!uuid.test(key)) throw new UnknownImprovementRequest('请求标识无效，请先核对上次提交结果。');
  const submitted = previous && previous.outcome !== 'rejected' ? previous.values : values;
  const record: ImprovementRequestRecord = {
    key,
    fingerprint,
    values: submitted,
    outcome: 'pending',
  };
  // A storage failure prevents the write entirely; never silently invent a replacement key after refresh.
  input.storage.setItem(input.scope, JSON.stringify(record));
  input.form.set('requestKey', key);
  for (const name of contextFields) {
    if (submitted[name] !== undefined) input.form.set(name, submitted[name]);
  }
  return record;
}

export function settleImprovementRequest(input: {
  storage: ImprovementRequestStorage;
  scope: string;
  record: ImprovementRequestRecord;
  state: ImprovementActionState;
}): void {
  if (input.state.outcome === 'confirmed') input.storage.removeItem(input.scope);
  else
    input.storage.setItem(
      input.scope,
      JSON.stringify({
        ...input.record,
        outcome: input.state.outcome === 'rejected' ? 'rejected' : 'unknown',
      }),
    );
}
