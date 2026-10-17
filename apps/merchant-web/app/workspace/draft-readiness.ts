import type { AssistantDraftConfig } from '@h5cs/domain';

export type DraftReadinessReminder = Readonly<{
  code: 'materials' | 'template' | 'pricing' | 'promotion' | 'after_sales' | 'human_contact';
  title: string;
  detail: string;
}>;

const unconfirmed =
  /尚未|未提供|未导入|待补充|待确认|需(?:要)?(?:向|联系)?商家(?:核实|确认)|资料不足/u;

/** Rule-based reminders, not a model review, quality score, or publication decision. */
export function reviewDraftReadiness(
  draft: AssistantDraftConfig,
): readonly DraftReadinessReminder[] {
  const reminders: DraftReadinessReminder[] = [];
  const materials = draft.materialsSummary.trim();
  if (materials.length === 0 || unconfirmed.test(materials))
    reminders.push({
      code: 'materials',
      title: '补充真实商品或服务资料',
      detail:
        '核对商品名称、型号/规格、适用条件或服务项目。消费者没有给出型号等必要条件时，应先追问，不推测商品事实。',
    });
  if (/电商零售基础知识与服务说明|通用咨询流程|通用知识|商家实际销售所有品类/u.test(materials))
    reminders.push({
      code: 'template',
      title: '通用模板不代表你的实际业务',
      detail:
        '模板只提供咨询边界和收集提示。请补充实际在售商品与有效政策；不要将模板中列举的品类、价格或服务当作商家事实。',
    });
  if (
    draft.pricingSummary.trim().length === 0 ||
    unconfirmed.test(draft.pricingSummary) ||
    !/(?:元|CNY|RMB|￥|¥|免费|不收费|另行报价|按实际订单)/iu.test(draft.pricingSummary) ||
    !/(?:每|\/|规格|型号|条件|起|含|不含|运费|费用|台|件|小时|次)/u.test(draft.pricingSummary)
  )
    reminders.push({
      code: 'pricing',
      title: '核对价格及适用条件',
      detail:
        '写清对应商品/规格、计价单位、运费与附加费用。价格尚未确定可以明确保留“需商家确认”，AI 不应代为报价。',
    });
  const promotion = draft.promotionSummary.trim();
  const noPromotion =
    /^(?:目前|当前|已确认)?(?:暂无|无)(?:已确认)?优惠(?:活动|信息)?[。.!！\s]*$/u.test(promotion);
  if (
    !noPromotion &&
    (promotion.length === 0 ||
      unconfirmed.test(promotion) ||
      !/(?:门槛|满.{0,20}\d|无门槛|适用|范围)/u.test(promotion) ||
      !/(?:期限|有效|截止|长期|起止|\d{4}[-/.年]|\d{1,2}月\d{1,2}日)/u.test(promotion) ||
      !/(?:叠加|同享|同用|互斥)/u.test(promotion))
  )
    reminders.push({
      code: 'promotion',
      title: '写清优惠门槛、期限和叠加规则',
      detail:
        '有活动时说明适用商品、门槛、有效期及能否叠加；没有活动可明确写“暂无优惠”。本提示不会判断活动是否真实或仍然有效。',
    });
  if (
    !/(?:售后|退换|退款|保修)/u.test(materials) ||
    !/(?:期限|天|条件|费用|运费|流程)/u.test(materials)
  )
    reminders.push({
      code: 'after_sales',
      title: '补充售后处理边界',
      detail:
        '核对退换/保修适用条件、期限、费用及办理方式。没有依据时应说明需核实，不承诺所有商品统一退换。',
    });
  if (!draft.humanContact?.trim())
    reminders.push({
      code: 'human_contact',
      title: '尚未提供人工联系说明',
      detail:
        '建议填写真实联系方式与服务时间，方便投诉、无法回答或要求人工的消费者联系。此处不提供实时人工转接。',
    });
  return reminders;
}
