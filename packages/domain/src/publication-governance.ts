import type { AssistantDraftConfig } from './assistant-lifecycle-repository.js';

export type BusinessFactIssue = Readonly<{
  code:
    | 'PRICE_CONFLICT'
    | 'FAQ_CONFLICT'
    | 'EXPIRED_RULE'
    | 'RULE_TIME_REVIEW'
    | 'PRICE_REVIEW'
    | 'FAQ_REVIEW';
  field: string;
  detail: string;
  severity: 'blocking' | 'warning';
}>;

export type PublicationGovernance = Readonly<{
  draftRevision: number;
  activeReleaseNo: number | null;
  activeDraftRevision: number | null;
  hasUnpublishedChanges: boolean;
  hasPublishedHistory: boolean;
  canManage: boolean;
  quality: Readonly<{
    state: 'not_tested' | 'needs_review' | 'passed' | 'failed';
    checkId: string | null;
    question: string | null;
    answer: string | null;
    testedAt: string | null;
  }>;
  issues: readonly BusinessFactIssue[];
  capacity: Readonly<{
    effectiveCharacters: number;
    maximumCharacters: 4000;
    uploadedMaterialCount: number;
    sourceCoverage: 'not_tracked';
  }>;
  withdrawal: Readonly<{
    withdrawnThroughReleaseNo: number;
    withdrawnAt: string | null;
    reason: string | null;
  }>;
}>;

export class AssistantGovernanceError extends Error {
  public constructor(
    public readonly code:
      'PREVIEW_REQUIRED' | 'FACTS_BLOCKED' | 'WITHDRAWAL_CONFLICT' | 'GOVERNANCE_CONFLICT',
  ) {
    super(code);
    this.name = 'AssistantGovernanceError';
  }
}

/** Narrow deterministic checks only. Different wording is never guessed to be the same fact. */
export function inspectBusinessFacts(
  draft: Pick<AssistantDraftConfig, 'materialsSummary' | 'pricingSummary' | 'promotionSummary'>,
  now: Date,
): readonly BusinessFactIssue[] {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid business clock');
  const fields = [
    ['materialsSummary', '商品/服务资料', draft.materialsSummary],
    ['pricingSummary', '价格与条件', draft.pricingSummary],
    ['promotionSummary', '优惠与策略', draft.promotionSummary],
  ] as const;
  const issues: BusinessFactIssue[] = [];
  const quotes = new Map<string, { amount: string; field: string }>();
  const questions = new Map<string, { answer: string; field: string }>();
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '').trim();
  const seen = new Set<string>();
  const add = (issue: BusinessFactIssue) => {
    const key = `${issue.code}:${issue.field}:${issue.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  };
  for (const [field, label, value] of fields) {
    const normalized = value.normalize('NFKC');
    // Exact named quotes such as “挂机清洗：79元”. Distinct SKUs/conditions keep distinct keys.
    for (const line of normalized.split(/[\n；;]/u)) {
      const quote =
        /^\s*([^:：。！？]{1,50})\s*[:：]\s*(\d+(?:\.\d{1,2})?)\s*(?:元|CNY|人民币)(.*)$/iu.exec(
          line,
        ) ??
        (field !== 'promotionSummary'
          ? /^\s*()\s*(\d+(?:\.\d{1,2})?)\s*(?:元|CNY|人民币)(.*)$/iu.exec(line)
          : null);
      if (!quote) continue;
      const labelKey = normalize(quote[1]!).replace(/(?:价格|售价|收费|单价|报价)$/u, '');
      if (
        /^(?:问|答|Q|A)$/iu.test(labelKey) ||
        /原价|优惠价|会员价|折后|起价|最低|最高/u.test(labelKey)
      )
        continue;
      // Unit and explicit suffix conditions are part of the comparable fact. Do
      // not block “79元/台，仅壁挂机” against “99元/台，仅柜机”.
      const conditions = normalize(quote[3]!).replace(/^[，,。]+/u, '');
      const key = `${labelKey || '$base-price'}:${conditions}`;
      const amount = String(Number(quote[2]));
      const prior = quotes.get(key);
      if (prior && prior.amount !== amount) {
        add({
          code: 'PRICE_CONFLICT',
          field,
          severity: 'blocking',
          detail: `${label}与其他资料中同名项目的明确报价不一致，请统一项目及适用条件后重新试聊。`,
        });
      } else quotes.set(key, { amount, field });
    }
    for (const match of normalized.matchAll(
      /(?:^|\n)\s*(?:问|Q)[:：]([^\n]+)\n\s*(?:答|A)[:：]([\s\S]*?)(?=\n\s*(?:问|Q)[:：]|$)/giu,
    )) {
      const question = normalize(match[1]!).replace(/[?？]$/u, '');
      const answer = normalize(match[2]!);
      if (!question || !answer) continue;
      const prior = questions.get(question);
      if (prior && prior.answer !== answer) {
        const template = (text: string) => text.replace(/\d+(?:\.\d+)?/gu, '#');
        const numericConflict =
          /\d/u.test(prior.answer) &&
          /\d/u.test(answer) &&
          template(prior.answer) === template(answer);
        const binaryConflict = [
          ['是', '否'],
          ['支持', '不支持'],
          ['可以', '不可以'],
        ].some((pair) => pair.includes(prior.answer) && pair.includes(answer));
        add({
          code: numericConflict || binaryConflict ? 'FAQ_CONFLICT' : 'FAQ_REVIEW',
          field,
          severity: numericConflict || binaryConflict ? 'blocking' : 'warning',
          detail:
            numericConflict || binaryConflict
              ? `${label}中同一问题、相同条件的数值或明确结论不一致，请统一后重新试聊。`
              : `${label}中同一问题存在不同表述或适用条件，请人工核对；系统不能判断其是否语义矛盾。`,
        });
      } else questions.set(question, { answer, field });
    }
    for (const date of normalized.matchAll(
      /(?:有效期至|有效至|截止(?:日期|时间)?|到期(?:日期)?)[:：\t ]*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/gu,
    )) {
      const year = Number(date[1]),
        month = Number(date[2]),
        day = Number(date[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      const invalidDay =
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day;
      const tail = normalized.slice((date.index ?? 0) + date[0].length).replace(/^[\t ，,]*/u, '');
      const clock = /^(?:T|北京时间|中国标准时间)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/iu.exec(tail);
      const hour = clock ? Number(clock[1]) : null;
      const minute = Number(clock?.[2] ?? 0),
        second = Number(clock?.[3] ?? 0);
      const remainder = clock ? tail.slice(clock[0].length).trimStart() : tail;
      // Explicit but unsupported/invalid times must never silently receive a
      // later end-of-day expiry. Supported timestamps use Beijing local time.
      if (
        invalidDay ||
        (hour !== null && (hour > 23 || minute > 59 || second > 59)) ||
        (!clock &&
          (/^(?:T|北京时间|中国标准时间|[+-]?\d+\s*[:时点]|上午|下午|晚上|中午|UTC|GMT|Z|[+-]\d{2}:?\d{2})/iu.test(
            tail,
          ) ||
            /^[^，,。；;\n]{0,40}[+-]?\d+\s*[:时点]/u.test(tail))) ||
        (clock &&
          /^(?:[\d.:]|时|分|秒|北京时间|中国标准时间|AM|PM|UTC|GMT|Z|[+-]\d{2}:?\d{2})/iu.test(
            remainder,
          ))
      ) {
        add({
          code: 'RULE_TIME_REVIEW',
          field,
          severity: 'blocking',
          detail: `${label}包含无法核对的明确截止日期或时刻，请填写有效日期 YYYY-MM-DD；若有时刻，使用北京时间 YYYY-MM-DD HH:mm[:ss]（24小时制）后重新试聊。`,
        });
        continue;
      }
      const cutoff =
        (hour === null
          ? Date.UTC(year, month - 1, day + 1)
          : Date.UTC(year, month - 1, day, hour, minute, second)) -
        8 * 3600000;
      if (now.getTime() >= cutoff)
        add({
          code: 'EXPIRED_RULE',
          field,
          severity: 'blocking',
          detail: `${label}包含已过截止日期的业务规则（${year}-${month}-${day}${hour === null ? '当日结束' : ` ${clock![1]}:${clock![2]}${clock![3] ? `:${clock![3]}` : ''}`}，北京时间），请移除或核实更新后再发布。`,
        });
    }
  }
  const amounts = fields.map(
    ([, , value]) => new Set(value.match(/\d+(?:\.\d{1,2})?\s*(?:元|CNY)/giu) ?? []),
  );
  if (
    !issues.some((issue) => issue.code === 'PRICE_CONFLICT') &&
    amounts.filter((set) => set.size).length > 1
  ) {
    add({
      code: 'PRICE_REVIEW',
      field: 'pricingSummary',
      severity: 'warning',
      detail:
        '多个位置含有金额，请核对商品、计价单位、优惠和适用条件；本检查不能识别全部语义冲突。',
    });
  }
  return issues;
}
