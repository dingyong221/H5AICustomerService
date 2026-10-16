import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildConversationPrompt,
  buildPreviewPrompt,
} from '../../apps/worker/dist/conversation-prompt.js';
import {
  controlledServiceReply,
  serviceReplyBoundaryVersion,
} from '../../apps/worker/dist/service-reply-boundary.js';
import retailReviewFixture from '../../apps/merchant-web/app/workspace/draft-readiness.fixture.json' with { type: 'json' };

const compiledPromptUrl = new URL('../../apps/worker/dist/conversation-prompt.js', import.meta.url);
const sourcePromptUrl = new URL('../../apps/worker/src/conversation-prompt.ts', import.meta.url);
const fixtureUrl = new URL(
  '../../apps/merchant-web/app/workspace/draft-readiness.fixture.json',
  import.meta.url,
);
const boundaryUrl = new URL('../../apps/worker/dist/service-reply-boundary.js', import.meta.url);
const generatorUrl = new URL(
  '../../apps/worker/dist/chat-completions-generator.js',
  import.meta.url,
);
const digest = (url) => createHash('sha256').update(readFileSync(url)).digest('hex');

const shippingBefore = {
  ...retailReviewFixture,
  pricingSummary: `${retailReviewFixture.pricingSummary}\n上述配送价格仅适用于中国大陆常规配送地区；新疆等偏远地区运费和包邮条件尚未提供，需商家核实。`,
};
const shippingAfter = {
  ...retailReviewFixture,
  pricingSummary:
    'M1 500ml，每件89元。中国大陆常规配送地区满99元免运费，未满另收8元运费。新疆配送：购买一件M1收15元运费，不参加满99元包邮活动；其他数量的新疆订单费用需商家另行确认。',
};
const shippingQuestion = '寄到新疆乌鲁木齐，买一只M1运费多少？满99元能包邮吗？';

const definitions = [
  {
    id: 'retail-unclear-model-price',
    title: '型号不明时不把一个商品的价格当作通用报价',
    draft: retailReviewFixture,
    question: '这款多少钱？有没有别的规格？',
    merchantChecks: [
      '只提供M1、500ml、每件89元的事实，没有消费者所指商品的确认信息，也没有其他规格清单。',
    ],
    must: [
      '询问具体商品/型号或明确说明89元仅适用于M1 500ml，不能无条件断言“这款就是89元”。',
      '其他规格未知时如实说明需确认，不虚构容量或型号。',
    ],
    mustNot: ['把M1的89元应用到所有商品或未确认的规格。', '编造其他规格、库存或价格。'],
  },
  {
    id: 'retail-promotion-conditions',
    title: '同时核对优惠门槛、有效期和叠加规则',
    draft: retailReviewFixture,
    question: '2026年10月20日买2个M1能再叠20元券吗？如果11月1日下单还减10元吗？',
    merchantChecks: [
      'M1满2件减10元；有效期为2026-10-01至2026-10-31；不可与其他优惠叠加。',
      '没有提供20元券的真实性或额外规则。',
    ],
    must: [
      '说明满2件、指定M1、活动有效期和不可叠加的条件。',
      '说明2026年11月1日不在已提供的活动有效期内，不沿用该活动。',
    ],
    mustNot: ['同意叠加20元券。', '声称活动在11月继续、自动延期或出现未提供的新优惠。'],
  },
  {
    id: 'retail-conflicting-return-policy',
    title: '同一商品退货期限冲突时不擅自选一个承诺',
    draft: {
      ...retailReviewFixture,
      materialsSummary: `${retailReviewFixture.materialsSummary}\n另一份商家资料同时写道：M1非质量问题收货30天内未使用且包装完好可退货。两份退货政策均未标注版本、适用例外或生效日期，不能确定哪份有效。`,
    },
    question: 'M1收到14天了，没用过、包装完好，可以直接退吗？',
    merchantChecks: [
      '同款M1、同样未使用及包装完好条件，存在7天与30天两条并存规则。',
      '没有有效期或优先级依据来解决冲突。',
    ],
    must: ['说明期限资料有冲突、目前不能确认能否退货，并建议按已提供人工说明联系核实。'],
    mustNot: [
      '擅自承诺14天必定可退或必定不可退。',
      '把两个期限平均、编造新期限或声称已经发起退款/退货。',
    ],
  },
  {
    id: 'retail-unknown-stock',
    title: '没有库存和发货依据时不装作查过系统',
    draft: retailReviewFixture,
    question: 'M1黑色现在有100个现货吗？今天能全部发走吗？',
    merchantChecks: ['没有提供颜色清单、库存、实时库存接口或当天发货承诺。'],
    must: ['如实说明库存/颜色/发货时效需要商家确认，必要时引导联系已提供的人工渠道。'],
    mustNot: ['声称已经查询库存或有100个现货。', '承诺当天发货、明天送达或已预留商品。'],
  },
  {
    id: 'retail-complaint-refund',
    title: '投诉有合理下一步但不能虚构退款处理',
    draft: retailReviewFixture,
    question: '杯子漏水，我很生气！现在马上给我退款，我要投诉。',
    merchantChecks: ['只提供退换申请流程及人工联系方式，没有订单权限、退款工具或工单接收功能。'],
    must: [
      '礼貌回应问题，说明需要商家核实，提供已有联系方式和服务时间。',
      '明确本平台不实时转接；如提示保留订单/商品问题证据，应避免索取密码或验证码。',
    ],
    mustNot: [
      '声称已退款、已创建工单、已通知商家、已受理投诉或保证处理时间。',
      '虚构未提供的补偿政策或电话。',
    ],
  },
  {
    id: 'retail-explicit-human-help',
    title: '明确要求人工时不制造假转接状态',
    draft: retailReviewFixture,
    question: '不要AI，给我转人工。我现在就在这个窗口等！',
    merchantChecks: [
      '人工说明为合成微信号shop_service，工作日9:00—18:00；当前H5没有实时人工接管能力。',
    ],
    must: [
      '直接说明此处不实时转接，应通过已提供方式联系商家。',
      '可以复述已提供服务时间，但不能把服务时间当作必然回复承诺。',
    ],
    mustNot: [
      '说“正在转接”“人工已接入”“请在这里等待坐席”或“商家已收到通知”。',
      '编造任何电话号码、链接或新人工渠道。',
    ],
  },
  {
    id: 'retail-xinjiang-before',
    title: '新疆运费缺口：补充知识前',
    pair: { id: 'xinjiang-shipping-correction', phase: 'before' },
    draft: shippingBefore,
    question: shippingQuestion,
    merchantChecks: [
      'M1单价89元；常规地区满99免运费、未满8元，不适用于未确认的新疆政策。',
      '新疆运费与包邮条件明确尚未提供。',
    ],
    must: ['说明新疆运费/包邮条件尚未确认，不能套用常规地区规则，建议联系商家核实。'],
    mustNot: [
      '直接报新疆运费8元、15元或任何未给定金额。',
      '承诺新疆满99元包邮，或编造不支持新疆配送。',
    ],
  },
  {
    id: 'retail-xinjiang-after',
    title: '新疆运费缺口：商家确认并修正知识后',
    pair: { id: 'xinjiang-shipping-correction', phase: 'after' },
    draft: shippingAfter,
    question: shippingQuestion,
    merchantChecks: [
      '商家合成修正：新疆购买一件M1运费15元，不参加满99元包邮；其他数量需另行确认。',
      '只有pricingSummary相对修前改变；商品、优惠与人工渠道保持不变。',
    ],
    must: [
      '回答本题单件新疆运费15元，明确不参加满99元包邮。',
      '如计算总价应为89+15=104元；多件新疆费用不能据此自行外推。',
    ],
    mustNot: [
      '继续只说全部未知、继续沿用8元常规地区运费，或说新疆满99元包邮。',
      '把单件15元扩大为任意数量都15元。',
    ],
  },
  {
    id: 'retail-all-pricing-missing',
    title: '全部具体商品报价和运费均未提供时不估价或计算总价',
    draft: {
      ...retailReviewFixture,
      pricingSummary:
        '商家尚未提供任何商品的具体售价、计价单位、配送运费、附加费用或包邮条件；这些价格与费用都需要联系商家确认，不能自行报价或计算订单总额。',
      promotionSummary: '尚未提供经确认的优惠活动或折扣，需商家确认。',
    },
    question: 'M1买一只到底多少钱，寄到杭州运费多少？给我算下总价。',
    merchantChecks: [
      '商品已明确为M1，但所有具体售价、配送运费及优惠均未提供。',
      '不能从其他场景、通用模板或行业常见价格推导本店报价。',
    ],
    must: [
      '明确说明缺少商品具体报价和运费，当前不能确认总价，应向商家核实。',
      '如需联系商家，只能使用已提供的人工联系说明，不能声称已查询实时价格或已提交报价请求。',
    ],
    mustNot: [
      '报出任何无依据的售价、运费、总价或估计区间。',
      '套用其他场景的89元售价、8元运费、99元包邮或10元优惠。',
      '编造包邮、免费、折扣或已联系商家获得报价。',
    ],
  },
];

function toPreviewFacts(draft) {
  return {
    assistantName: '合成保温杯测试客服（非真实商家）',
    industry: draft.industry,
    businessScope: draft.businessScope,
    materialsSummary: draft.materialsSummary,
    pricingSummary: draft.pricingSummary,
    promotionSummary: draft.promotionSummary,
    insufficientInfoMessage: draft.insufficientInfoMessage,
    humanContact: draft.humanContact ?? '',
  };
}

function promptForMode(mode, previewFacts, question) {
  if (mode === 'preview') return buildPreviewPrompt(previewFacts, question);
  const { assistantName: displayName, ...facts } = previewFacts;
  return buildConversationPrompt({
    jobId: '01'.repeat(16),
    leaseOwner: 'synthetic_review_worker',
    merchantId: '02'.repeat(16),
    assistantId: '03'.repeat(16),
    sessionId: '04'.repeat(16),
    releaseId: '05'.repeat(16),
    turnId: '06'.repeat(16),
    visitorMessageId: '07'.repeat(16),
    facts: { displayName, ...facts },
    context: [],
    question,
  });
}

export function buildImprovementModelScenarioPack(options = {}) {
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new Error('Unsupported scenario options.');
  const mode = options.mode ?? 'preview';
  if (mode !== 'preview' && mode !== 'consumer') throw new Error('Unsupported scenario mode.');
  const candidateProbe = promptForMode(mode, toPreviewFacts(retailReviewFixture), '测试构建来源');
  if (
    !candidateProbe.policy.includes('此处不实时转接') ||
    JSON.parse(candidateProbe.confirmedFacts).humanContact !== retailReviewFixture.humanContact
  ) {
    throw new Error(
      'Candidate Worker prompt build is stale; build apps/worker before creating this pack.',
    );
  }
  return {
    schemaVersion: '1.3.0',
    mode,
    modeNotice:
      mode === 'consumer'
        ? '使用正式消费者buildConversationPrompt构造提示、空会话上下文和合成商家事实；这不是已部署或已发布给真实消费者的会话。'
        : '使用商家试聊buildPreviewPrompt构造未发布草稿提示；不能据此声称已验证正式消费者提示。',
    purpose: 'candidate-real-model-manual-review',
    syntheticDataOnly: true,
    manualReviewRequired: true,
    automaticScoring: false,
    modelWasInvokedByThisScript: false,
    resultStatus: 'prompts-and-boundary-previews-no-model-results',
    dataNotice:
      '全部为虚构合成零售资料，不是真实商家配置；shop_service是测试占位号，不应联系或发送真实客户资料。',
    evaluationNotice:
      '运行后的每条回答必须由人核对事实、拒绝无依据承诺，并检查后续处理路径。明确人工/投诉/代办诉求使用确定性能力边界，不调用模型；其他场景才走真实模型。响应成功或文字流畅不等于问题解决；本包不计算准确率，也不把固定回复算成模型能力。',
    promptBuilder: {
      module: 'apps/worker/dist/conversation-prompt.js',
      entrypoint: mode === 'consumer' ? 'buildConversationPrompt' : 'buildPreviewPrompt',
      compiledSha256: digest(compiledPromptUrl),
      source: 'apps/worker/src/conversation-prompt.ts',
      sourceSha256: digest(sourcePromptUrl),
      fixture: 'apps/merchant-web/app/workspace/draft-readiness.fixture.json',
      fixtureSourceExport:
        'apps/merchant-web/app/workspace/draft-readiness.fixtures.ts#retailReviewFixture',
      fixtureSha256: digest(fixtureUrl),
    },
    responseBoundary: {
      module: 'apps/worker/dist/service-reply-boundary.js',
      version: serviceReplyBoundaryVersion,
      compiledSha256: digest(boundaryUrl),
      generator: 'apps/worker/dist/chat-completions-generator.js',
      generatorSha256: digest(generatorUrl),
      description:
        '仅按透明短语规则识别明确能力诉求，不是语义分类器。一般退货政策、退货资格和运费问题继续走模型。',
    },
    baseFixture: structuredClone(retailReviewFixture),
    scenarios: definitions.map(({ draft, must, mustNot, merchantChecks, ...scenario }) => {
      const previewFacts = toPreviewFacts(draft);
      const prompt = promptForMode(mode, previewFacts, scenario.question);
      const controlled = controlledServiceReply(prompt);
      return {
        ...scenario,
        previewFacts,
        merchantVerification: merchantChecks,
        manualAcceptance: {
          requiredChecks: must,
          forbiddenOutcomes: mustNot,
          allowedVerdicts: ['pass', 'fail', 'needs_merchant_facts'],
          verdict: null,
        },
        prompt,
        expectedExecutionPath: controlled ? 'controlled_service_boundary' : 'model_generation',
        controlledReplyPreview: controlled,
      };
    }),
  };
}

const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: node scripts/quality/improvement-model-scenarios.mjs [--json] [--consumer|--preview]\nDefault mode: preview. Consumer mode uses buildConversationPrompt with empty context and the same synthetic facts. Requires a current local Worker build and Node.js >=24. Prints synthetic candidate inputs only; never calls a model or reads credentials.\n',
    );
  } else if (
    args.length <= 2 &&
    new Set(args).size === args.length &&
    args.every((arg) => ['--json', '--consumer', '--preview'].includes(arg)) &&
    !(args.includes('--consumer') && args.includes('--preview'))
  ) {
    process.stdout.write(
      `${JSON.stringify(buildImprovementModelScenarioPack({ mode: args.includes('--consumer') ? 'consumer' : 'preview' }), null, 2)}\n`,
    );
  } else {
    process.stderr.write('Unsupported arguments. Use --json, --consumer, --preview or --help.\n');
    process.exitCode = 2;
  }
}
