/** Shared, bounded contract. No model credentials or merchant records belong here. */
export const writingFields = {
  displayName: {
    label: '客服名称',
    maximum: 200,
    multiline: false,
    example: '卖日用品的网店，想要亲切的客服名称',
  },
  industry: {
    label: '细分行业',
    maximum: 128,
    multiline: false,
    example: '线上零售家居用品和小家电',
  },
  businessScope: {
    label: '业务范围',
    maximum: 2000,
    multiline: true,
    example: '卖家居日用品，解答选购、规格和售后问题',
  },
  materialsSummary: {
    label: '商品或服务资料',
    maximum: 4000,
    multiline: true,
    example: '纯棉毛巾，尺寸 34×76 厘米，有蓝色和白色。其他信息待确认',
  },
  pricingSummary: {
    label: '价格与条件',
    maximum: 4000,
    multiline: true,
    example: '毛巾 29 元一条，运费和库存要联系客服确认',
  },
  promotionSummary: {
    label: '优惠与售卖策略',
    maximum: 4000,
    multiline: true,
    example: '目前没有已确认优惠，不承诺折扣或包邮',
  },
  welcomeMessage: {
    label: '欢迎语',
    maximum: 500,
    multiline: false,
    example: '欢迎顾客来问商品，语气亲切，不要太长',
  },
  insufficientInfoMessage: {
    label: '资料不足时的回复',
    maximum: 500,
    multiline: false,
    example: '不知道就说明待确认，请顾客联系商家，不假装已转人工',
  },
} as const;

export type WritingField = keyof typeof writingFields;
export type WritingInput = Readonly<{ field: WritingField; brief: string; currentText: string }>;
export type WritingResult = Readonly<{ options: readonly string[]; reminders: readonly string[] }>;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function isWritingField(value: unknown): value is WritingField {
  return typeof value === 'string' && Object.hasOwn(writingFields, value);
}

export function parseWritingInput(value: unknown): WritingInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    !isWritingField(input['field']) ||
    typeof input['brief'] !== 'string' ||
    typeof input['currentText'] !== 'string'
  )
    return null;
  const { field, brief, currentText } = input;
  if (
    !brief.trim() ||
    brief.length > 1000 ||
    controls.test(brief) ||
    currentText.length > writingFields[field].maximum ||
    controls.test(currentText)
  )
    return null;
  return { field, brief: brief.trim(), currentText: currentText.trim() };
}

export function parseWritingResult(value: unknown, field: WritingField): WritingResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const options = input['options'];
  const reminders = input['reminders'];
  if (
    !Array.isArray(options) ||
    options.length < 2 ||
    options.length > 3 ||
    !Array.isArray(reminders) ||
    reminders.length > 5
  )
    return null;
  const valid = (text: unknown, max: number): text is string =>
    typeof text === 'string' &&
    text.trim().length > 0 &&
    text.length <= max &&
    !controls.test(text);
  if (
    !options.every((text) => valid(text, Math.min(writingFields[field].maximum, 1000))) ||
    !reminders.every((text) => valid(text, 200))
  )
    return null;
  const normalized = options.map((text: string) =>
    writingFields[field].multiline
      ? text.trim().replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ')
      : text.trim().replace(/\s+/gu, ' '),
  );
  if (new Set(normalized).size < 2) return null;
  return { options: normalized, reminders: reminders.map((text: string) => text.trim()) };
}
