import type { KnowledgeMaterial } from '@h5cs/database';

export const materialKinds = ['all', 'document', 'table', 'text'] as const;
export type MaterialKind = (typeof materialKinds)[number];
export function materialKind(name: string): Exclude<MaterialKind, 'all'> {
  return /\.(?:xlsx?|csv)$/iu.test(name)
    ? 'table'
    : /\.(?:pdf|docx?|pptx?)$/iu.test(name)
      ? 'document'
      : 'text';
}
export function filterMaterials(
  materials: readonly KnowledgeMaterial[],
  query: string,
  kind: MaterialKind,
): readonly KnowledgeMaterial[] {
  const needle = query.trim().toLocaleLowerCase();
  return materials.filter(
    (item) =>
      (kind === 'all' || materialKind(item.name) === kind) &&
      (!needle || `${item.name}\n${item.text}`.toLocaleLowerCase().includes(needle)),
  );
}
export type MaterialReminder = Readonly<{
  code: 'duplicate' | 'faq_conflict' | 'expired';
  sourceIds: readonly string[];
  detail: string;
}>;

/** Local deterministic reminders only: no semantic review, auto-delete or publication decision. */
export function reviewMaterials(
  materials: readonly KnowledgeMaterial[],
  now = new Date(),
): readonly MaterialReminder[] {
  const reminders: MaterialReminder[] = [];
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const fingerprints = new Map<string, KnowledgeMaterial>();
  const faq = new Map<string, { answer: string; source: KnowledgeMaterial }>();
  for (const item of materials) {
    const keys = [`sha:${item.sha256}`, `text:${normalize(item.text)}`];
    const duplicate = keys.map((key) => fingerprints.get(key)).find(Boolean);
    if (duplicate)
      reminders.push({
        code: 'duplicate',
        sourceIds: [duplicate.id, item.id],
        detail: `“${item.name}”与“${duplicate.name}”文件指纹或提取文字相同，请避免重复追加。`,
      });
    for (const key of keys) if (!fingerprints.has(key)) fingerprints.set(key, item);
    // Only explicit Q/A blocks qualify. Different wording is not guessed to mean the same question.
    const blocks = item.text.matchAll(
      /(?:^|\n)[\t ]*(?:问|Q)[：:]([^\n]+)\n[\t ]*(?:答|A)[：:]([\s\S]*?)(?=\n[\t ]*(?:问|Q)[：:]|$)/giu,
    );
    for (const block of blocks) {
      const question = normalize(block[1]!).replace(/[?？]$/u, '');
      const answer = normalize(block[2]!);
      if (!question || !answer) continue;
      const previous = faq.get(question);
      if (previous && previous.answer !== answer)
        reminders.push({
          code: 'faq_conflict',
          sourceIds: [previous.source.id, item.id],
          detail: `问题“${question}”在“${previous.source.name}”与“${item.name}”的答案不同，请核对适用条件；系统不会代选。`,
        });
      else if (!previous) faq.set(question, { answer, source: item });
    }
    const dates = item.text.matchAll(
      /(?:有效期至|有效至|截止(?:日期|时间)?|到期(?:日期)?)[：:\t ]*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/gu,
    );
    for (const date of dates) {
      const year = Number(date[1]),
        month = Number(date[2]),
        day = Number(date[3]);
      const calendar = new Date(Date.UTC(year, month - 1, day));
      if (
        calendar.getUTCFullYear() !== year ||
        calendar.getUTCMonth() !== month - 1 ||
        calendar.getUTCDate() !== day
      )
        continue;
      // Business dates are inclusive until the end of the named day in Asia/Shanghai.
      if (now.getTime() >= Date.UTC(year, month - 1, day + 1) - 8 * 3600000) {
        reminders.push({
          code: 'expired',
          sourceIds: [item.id],
          detail: `“${item.name}”含已过去的截止日期 ${year}-${month}-${day}，请确认是否仍适用；不会自动下架。`,
        });
        break;
      }
    }
  }
  return reminders;
}

export const knowledgeTemplates = [
  {
    id: 'product',
    title: '商品资料',
    text: '【商品资料】\n商品名称：待补充\n规格/型号/单位：待补充\n用途及适用对象：待补充\n不适用条件：待补充',
  },
  {
    id: 'service',
    title: '服务项目',
    text: '【服务项目】\n项目名称：待补充\n包含/不包含：待补充\n适用地区与预约条件：待补充\n服务时间：待补充',
  },
  {
    id: 'price',
    title: '价格与优惠',
    text: '【价格与优惠】\n商品/服务及计价单位：待补充\n价格与额外费用：待补充\n优惠门槛与适用范围：待补充\n有效期与叠加规则：待补充\n单独价格/优惠字段也需核对，不能互相矛盾。',
  },
  {
    id: 'hours',
    title: '营业时间',
    text: '【营业时间】\n工作日时间：待补充\n周末与节假日安排：待补充\n时区/地区：待补充\n非营业时间的处理方式：待补充',
  },
  {
    id: 'after_sales',
    title: '配送与售后',
    text: '【配送与售后】\n适用商品/地区：待补充\n发货条件、时效与运费：待补充\n退换/保修条件、期限与费用：待补充\n办理步骤与人工联系：待补充',
  },
  {
    id: 'faq',
    title: '常见问答',
    text: '问：待补充顾客常问的问题\n答：待补充有依据的回答，并写明条件；未知信息请保留需商家确认。',
  },
] as const;
