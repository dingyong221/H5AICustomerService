import type { ConversationPrompt } from './conversation-prompt.js';

export const serviceReplyBoundaryVersion = 'explicit-service-request-v1';
export type ControlledServiceReason = 'human_help' | 'complaint' | 'transaction_action';
export type ControlledServiceReply = Readonly<{
  reason: ControlledServiceReason;
  answer: string;
  boundaryVersion: typeof serviceReplyBoundaryVersion;
}>;

// These are intentionally narrow, visible phrase rules, not a semantic intent classifier.
// Policy/eligibility/cost questions remain model questions unless they also contain an
// explicit request to contact a person, complain, or carry out an unsupported action.
const humanRequest =
  /转(?:接)?(?:到|给)?人工|找(?:个|一下)?(?:人工|真人)|接(?:入|通)人工|联系(?:人工|真人)|(?:我要|需要|请给我)(?:人工|真人)|人工(?:客服)?(?:联系方式|电话|微信)|(?:talk|speak|connect|transfer)(?:me)?(?:to|with)?(?:a|an)?(?:human|person|agent)|(?:human|liveagent)please/iu;
const complaintRequest =
  /(?:我要|我想|我要求|要求|帮我|替我|给我)(?:提出|发起|进行)?(?:投诉|申诉|举报)|(?:投诉|举报)(?:你们|商家|店铺|这家)|投诉(?:电话|联系方式|入口|渠道)/u;
const actionRequest =
  /(?:帮我|替我|给我|为我|代我)(?:现在|马上|立刻|立即|直接)?(?:办理|处理|申请|发起|操作|执行|提交|安排)?(?:全额)?(?:退款|退钱|赔偿|补偿|退货|换货|取消订单|修改订单|更改订单|(?:修改|更改)(?:收货)?地址|改地址|下单|付款|支付|发货|催单|催发货|开票|开发票|预约)|(?:现在|马上|立刻|立即|直接)(?:就)?(?:退款|退钱|赔偿|补偿|取消订单|改地址|发货)|(?:我要|我想要|我要求)(?:退款|退钱|赔偿|补偿|取消订单)/u;
const declinedHuman =
  /(?:不用|不要|不必|无需|不需要|别)(?:你|给我|帮我|再)?(?:转(?:接)?|找|联系|接通|接入)?(?:人工|真人)/u;
const declinedAction =
  /(?:不用|不要|不必|无需|不需要|别)(?:你|给我|帮我|替我|为我|再)?(?:办理|处理|操作|申请|发起|执行|提交|安排)?(?:退款|退钱|赔偿|补偿|退货|换货|取消订单|(?:修改|更改)(?:收货)?地址|改地址|下单|支付|发货|开票|预约)/u;
const declinedComplaint =
  /(?:不用|不要|不必|无需|不需要|别)(?:你|帮我|替我|给我)?(?:提出|发起|进行)?(?:投诉|申诉|举报)/u;

export function explicitServiceReason(question: string): ControlledServiceReason | null {
  const normalized = question.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]+/gu, '');
  const clauses = normalized.split(/[，,。！？!?；;]/u);
  if (clauses.some((clause) => !declinedHuman.test(clause) && humanRequest.test(clause)))
    return 'human_help';
  if (clauses.some((clause) => !declinedComplaint.test(clause) && complaintRequest.test(clause)))
    return 'complaint';
  if (clauses.some((clause) => !declinedAction.test(clause) && actionRequest.test(clause)))
    return 'transaction_action';
  return null;
}

function contactFromFacts(confirmedFacts: string): string {
  try {
    const facts: unknown = JSON.parse(confirmedFacts);
    if (
      typeof facts !== 'object' ||
      facts === null ||
      Array.isArray(facts) ||
      !Object.hasOwn(facts, 'humanContact')
    )
      return '';
    const raw = (facts as Record<string, unknown>)['humanContact'];
    if (typeof raw !== 'string') return '';
    const contact = raw.replace(/\r\n?/gu, '\n').trim();
    return contact.length <= 500 && !/[\u0000-\u0009\u000b-\u001f\u007f<>]/u.test(contact)
      ? contact
      : '';
  } catch {
    return '';
  }
}

/** No model, network, write, escalation or transaction takes place in this function. */
export function controlledServiceReply(
  prompt: Pick<ConversationPrompt, 'question' | 'confirmedFacts'>,
): ControlledServiceReply | null {
  const reason = explicitServiceReason(prompt.question);
  if (reason === null) return null;
  const contact = contactFromFacts(prompt.confirmedFacts);
  const introduction =
    reason === 'complaint'
      ? '理解您希望尽快解决问题，这种情况需要商家人工核实处理。'
      : reason === 'human_help'
        ? '如需人工帮助，请通过商家提供的渠道联系。'
        : '退款、赔偿或订单操作需要由商家人工核实处理。';
  const answer = [
    introduction,
    '此窗口不实时转接人工，也不会自动通知商家、提交申请或受理事项；我不能代办退款、赔偿或订单操作，也不能承诺运费承担方、处理结果或回复时效。',
    contact
      ? `商家提供的人工联系说明：\n${contact}`
      : '商家尚未提供人工联系说明。请通过您购买商品或服务时使用的原购买渠道联系商家人工。',
    '请直接向商家说明问题，必要时提供订单信息和问题详情；不要发送支付密码或验证码。',
  ].join('\n');
  return { reason, answer, boundaryVersion: serviceReplyBoundaryVersion };
}
