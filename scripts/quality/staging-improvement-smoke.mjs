import { randomBytes, randomInt } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone private-staging journey. Importing this file never launches a browser.
// Do not run with Playwright debug recording, attach to a user's browser, or persist auth state.
export const modelExecutionBoundary = Object.freeze({
  requestedMode: 'real',
  runtimeProviderVerified: false,
  verificationRequired: 'independent_worker_configuration_and_image_evidence',
});

export const syntheticRetailScenario = Object.freeze({
  question: '新疆单件运费，满99是否包邮',
  previewQuestion: '500ml保温杯单件多少钱，普通地区运费和包邮门槛是什么？',
  industry: '电商零售 / 各类零售商品',
  businessScope: '仅为本次私有预发布验收提供合成保温杯商品咨询，不是真实店铺。',
  materialsSummary: '合成零售商品：500ml保温杯。没有提供库存、其他型号或其他规格的售价。',
  pricingSummary:
    '500ml保温杯单件89元。普通地区运费8元，普通地区商品金额满99元包邮。新疆按单独已确认的具体补充规则；没有新疆规则时，其运费及满99包邮资格均未确认，不能套用普通地区政策。',
  promotionSummary: '暂无已确认优惠；不得自行编造折扣、优惠券或叠加条件。',
  welcomeMessage: '您好，我是合成测试店的AI客服。这里只验证客服功能，不提供真实交易。',
  insufficientInfoMessage:
    '未提供或未核对的库存、价格及地区运费不能猜测，请通过SYNTHETIC_ORDER_HELP联系商家核实。',
  humanContact:
    '人工渠道：SYNTHETIC_ORDER_HELP（仅验收标识，不是真实联系方式）。工作日09:00—18:00，请在测试购买渠道订单页联系人工。',
  correctedAnswer: '新疆单件运费15元，不参加满99包邮，其他数量另确认。',
  beforeCriteria: '新疆单件运费及满99包邮资格尚未确认；不能把普通地区8元或满99包邮套用于新疆。',
  afterCriteria:
    '明确新疆单件运费15元，且不参加满99包邮；其他数量需另行确认。不得将普通地区8元或满99包邮政策套用于新疆，不得假称已下单、通知或受理。',
});

export class StagingSmokeSafetyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StagingSmokeSafetyError';
    this.code = code;
  }
}

const fail = (code) => {
  throw new StagingSmokeSafetyError(code);
};
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const hexId = (value) => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
const opaque = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
const sessionId = (value) => typeof value === 'string' && /^s_[0-9a-f]{32}$/u.test(value);
const turnId = (value) => typeof value === 'string' && /^t_[0-9a-f]{32}$/u.test(value);
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const exactKeys = (value, keys) =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function parseStagingImprovementOptions(environment, args = []) {
  if (args.length !== 0) fail('INVALID_ARGUMENTS');
  let origin;
  try {
    origin = new URL(environment.H5CS_STAGE_ORIGIN);
  } catch {
    fail('INVALID_PRIVATE_ORIGIN');
  }
  if (
    origin.origin !== environment.H5CS_STAGE_ORIGIN ||
    origin.protocol !== 'https:' ||
    !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
    !origin.port ||
    origin.username ||
    origin.password
  )
    fail('INVALID_PRIVATE_ORIGIN');
  if (environment.H5CS_STAGE_MODEL_MODE !== 'real') fail('REAL_MODEL_MODE_REQUIRED');
  if (environment.H5CS_STAGE_SYNTHETIC_DATA_CONSENT !== 'true')
    fail('SYNTHETIC_DATA_CONSENT_REQUIRED');
  const username = environment.H5CS_STAGE_OPERATOR_USERNAME;
  const password = environment.H5CS_STAGE_OPERATOR_PASSWORD;
  if (
    typeof username !== 'string' ||
    !username.trim() ||
    username.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(username) ||
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(password)
  )
    fail('OPERATOR_CREDENTIALS_REQUIRED');
  const chromePath = environment.H5CS_STAGE_CHROME_PATH;
  if (
    typeof chromePath !== 'string' ||
    !isAbsolute(chromePath) ||
    /[\u0000-\u001f\u007f]/u.test(chromePath)
  )
    fail('ABSOLUTE_BROWSER_PATH_REQUIRED');
  if (
    ['DEBUG', 'PWDEBUG', 'PW_TEST_CONNECT_WS_ENDPOINT', 'PLAYWRIGHT_WS_ENDPOINT'].some((name) =>
      Boolean(environment[name]),
    )
  )
    fail('BROWSER_DEBUG_OR_ATTACH_FORBIDDEN');
  const reviewSeconds = environment.H5CS_STAGE_REVIEW_TIMEOUT_SECONDS ?? '300';
  if (!/^[1-9][0-9]{1,2}$/u.test(reviewSeconds)) fail('INVALID_REVIEW_TIMEOUT');
  const reviewTimeoutMs = Number(reviewSeconds) * 1000;
  if (reviewTimeoutMs < 30_000 || reviewTimeoutMs > 900_000) fail('INVALID_REVIEW_TIMEOUT');
  return Object.freeze({
    origin: origin.origin,
    username,
    password,
    chromePath,
    reviewTimeoutMs,
  });
}

export function allowedStagingRequest(urlValue, origin) {
  try {
    const url = new URL(urlValue);
    return url.origin === origin && url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function checkedStagingLink(value, origin, kind) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('UNVERIFIED_STAGING_LINK');
  }
  if (!allowedStagingRequest(url.href, origin) || url.search) fail('UNVERIFIED_STAGING_LINK');
  if (
    kind === 'setup'
      ? url.pathname !== '/console/setup' || !/^#[A-Za-z0-9_-]{43}$/u.test(url.hash)
      : kind === 'public'
        ? !/^\/a\/[a-z0-9-]{1,128}$/u.test(url.pathname) || Boolean(url.hash)
        : true
  )
    fail('UNVERIFIED_STAGING_LINK');
  return url;
}

export function checkedAcceptedTurn(data, sessionHandle, origin) {
  if (
    !sessionId(sessionHandle) ||
    !exactKeys(data, ['turnId', 'traceId', 'state', 'eventsUrl', 'resultUrl']) ||
    data.state !== 'accepted' ||
    !turnId(data.turnId) ||
    !opaque(data.traceId)
  )
    fail('UNVERIFIED_ACCEPTED_TURN');
  const path = `/api/v1/public/sessions/${sessionHandle}/turns/${data.turnId}`;
  for (const [field, expected] of [
    ['resultUrl', path],
    ['eventsUrl', `${path}/events`],
  ]) {
    let url;
    try {
      if (typeof data[field] !== 'string') fail('UNVERIFIED_ACCEPTED_TURN');
      url = new URL(data[field], origin);
    } catch {
      fail('UNVERIFIED_ACCEPTED_TURN');
    }
    if (url.href !== `${origin}${expected}`) fail('UNVERIFIED_ACCEPTED_TURN');
  }
  return { path, turnId: data.turnId, traceId: data.traceId };
}

export function checkedCompletedTurn(data, expected) {
  if (
    !exactKeys(data, ['messages', 'sessionHandle', 'state', 'traceId', 'turnId']) ||
    data.state !== 'completed' ||
    data.sessionHandle !== expected.sessionHandle ||
    data.turnId !== expected.turnId ||
    data.traceId !== expected.traceId ||
    !Array.isArray(data.messages) ||
    data.messages.length !== 2
  )
    fail('UNVERIFIED_COMPLETED_TURN');
  const [visitor, assistant] = data.messages;
  if (
    !record(visitor) ||
    !record(assistant) ||
    visitor.role !== 'visitor' ||
    assistant.role !== 'assistant' ||
    visitor.clientMessageId !== expected.clientMessageId ||
    visitor.content !== expected.question ||
    !opaque(visitor.messageId) ||
    !opaque(assistant.messageId) ||
    visitor.messageId === assistant.messageId ||
    !Number.isSafeInteger(visitor.sequence) ||
    visitor.sequence < 1 ||
    assistant.sequence !== visitor.sequence + 1 ||
    !timestamp(visitor.createdAt) ||
    !timestamp(assistant.createdAt) ||
    typeof assistant.content !== 'string' ||
    !assistant.content.trim()
  )
    fail('UNVERIFIED_COMPLETED_TURN');
  return assistant.content;
}

export function checkedSessionHistory(data, expected) {
  if (
    !exactKeys(data, [
      'sessionHandle',
      'releaseRef',
      'createdAt',
      'snapshot',
      'messages',
      'activeTurn',
      'hasEarlierMessages',
    ]) ||
    !sessionId(data.sessionHandle) ||
    data.sessionHandle !== expected.sessionHandle ||
    !hexId(data.releaseRef) ||
    data.releaseRef !== expected.releaseRef ||
    !timestamp(data.createdAt) ||
    !record(data.snapshot) ||
    data.snapshot.releaseRef !== expected.releaseRef ||
    !Array.isArray(data.messages) ||
    data.activeTurn !== null ||
    typeof data.hasEarlierMessages !== 'boolean' ||
    !data.messages.some(
      (message) =>
        record(message) &&
        message.role === 'assistant' &&
        message.content === expected.requiredAnswer,
    )
  )
    fail('UNVERIFIED_SESSION_HISTORY');
  return data;
}

export function answerForEvidence(value, secrets = []) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 8000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    secrets.some(
      (secret) => typeof secret === 'string' && secret.length > 3 && value.includes(secret),
    ) ||
    /(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [^-]*PRIVATE KEY|h5cs_visitor\s*=|\bBearer\s+[A-Za-z0-9._-]{8,}|\b1[3-9][0-9]{9}\b)/iu.test(
      value,
    )
  )
    fail('ANSWER_NOT_SAFE_TO_PRINT');
  return value.trim();
}

// A fresh, non-secret challenge binds each approval to the evidence just printed.
// There is deliberately no environment/CLI auto-approval and no default pass on EOF/timeout.
export function waitForManualDecision(input, { challenge, timeoutMs }) {
  if (!/^r1_[0-9a-f]{16}$/u.test(challenge) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    fail('INVALID_MANUAL_GATE');
  return new Promise((resolveDecision, reject) => {
    let text = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.pause();
      if (code) reject(new StagingSmokeSafetyError(code));
      else resolveDecision('pass');
    };
    const onData = (chunk) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > 128) return finish('MANUAL_INPUT_REJECTED');
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      if (text.slice(newline + 1).trim()) return finish('MANUAL_INPUT_REJECTED');
      const line = text.slice(0, newline).replace(/\r$/u, '');
      if (line === 'abort') return finish('MANUAL_ABORTED');
      if (line !== `pass ${challenge}`) return finish('MANUAL_INPUT_REJECTED');
      finish();
    };
    const onEnd = () => finish('MANUAL_INPUT_ENDED');
    const onError = () => finish('MANUAL_INPUT_FAILED');
    const timer = setTimeout(() => finish('MANUAL_REVIEW_TIMED_OUT'), timeoutMs);
    if (input.readableEnded || input.destroyed) return finish('MANUAL_INPUT_ENDED');
    if (input.readableLength > 0) return finish('MANUAL_PREBUFFERED_INPUT');
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

async function runStagingImprovementSmoke(options, input = process.stdin) {
  let browser;
  let step = 'load-browser';
  const secrets = [options.username, options.password];
  const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    const { chromium, expect } = await import('@playwright/test');
    browser = await chromium.launch({ executablePath: options.chromePath, headless: true });
    let outsideOriginRequested = false;
    const newPrivateContext = async () => {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true, // Only this explicit loopback HTTPS origin is allowed below.
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      await context.route('**/*', async (route) => {
        if (!allowedStagingRequest(route.request().url(), options.origin)) {
          outsideOriginRequested = true;
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      context.setDefaultTimeout(30_000);
      context.setDefaultNavigationTimeout(30_000);
      return context;
    };
    const verifyPage = (page) => {
      if (outsideOriginRequested || !allowedStagingRequest(page.url(), options.origin))
        fail('OUTSIDE_PRIVATE_ORIGIN_BLOCKED');
    };
    const goto = async (page, path) => {
      const response = await page.goto(`${options.origin}${path}`);
      verifyPage(page);
      if (!response || response.status() !== 200) fail('PAGE_NOT_READY');
    };
    const readJson = async (page, path) => {
      if (!path.startsWith('/api/v1/public/') || path.includes('?') || path.includes('#'))
        fail('UNVERIFIED_READ_PATH');
      const result = await page.evaluate(async (target) => {
        const response = await fetch(target, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-H5CS-Features': 'human-contact' },
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        });
        return { status: response.status, payload: await response.json() };
      }, path);
      verifyPage(page);
      if (
        result.status !== 200 ||
        !exactKeys(result.payload, ['data', 'request_id']) ||
        !record(result.payload.data)
      )
        fail('UNVERIFIED_PUBLIC_READ');
      return result.payload.data;
    };
    const confirmMaterials = async (page, merchantId, assistantId) => {
      await goto(page, `/${merchantId}/knowledge/${assistantId}`);
      await page.getByLabel(/我已逐项核对以上资料/u).check();
      await page.getByRole('button', { name: '确认当前草稿资料', exact: true }).click();
      await expect(
        page.getByText('当前草稿资料已确认；正式发布仍需完成对话服务与发布检查。', {
          exact: true,
        }),
      ).toBeVisible();
    };
    const publish = async (page, merchantId, assistantId, releaseNumber) => {
      await goto(page, `/${merchantId}/publish/${assistantId}`);
      await page.getByLabel(/我确认发布当前修订/u).check();
      await page.getByRole('button', { name: '确认发布 AI 客服', exact: true }).click();
      await expect(
        page.getByText(`Release #${releaseNumber} 已发布。`, { exact: true }),
      ).toBeVisible();
      const link = page.locator(`a[href^="${options.origin}/a/"]`).first();
      await expect(link).toBeVisible();
      return checkedStagingLink(await link.getAttribute('href'), options.origin, 'public');
    };
    const sendQuestion = async (page, { publicSlug, session, releaseRef }) => {
      verifyPage(page);
      const bubbles = page.locator('.message-row--assistant .message-bubble p');
      const priorCount = await bubbles.count();
      await page
        .getByRole('textbox', { name: '输入想咨询的问题', exact: true })
        .fill(syntheticRetailScenario.question);
      const isResponse = (response, path, status) =>
        response.request().method() === 'POST' &&
        response.url() === `${options.origin}${path}` &&
        response.status() === status;
      const createdResponse = session
        ? Promise.resolve(null)
        : page.waitForResponse(
            (response) =>
              isResponse(response, `/api/v1/public/assistants/${publicSlug}/sessions`, 201),
            { timeout: 90_000 },
          );
      const acceptedResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          allowedStagingRequest(response.url(), options.origin) &&
          /^\/api\/v1\/public\/sessions\/s_[0-9a-f]{32}\/messages$/u.test(
            new URL(response.url()).pathname,
          ) &&
          response.status() === 202,
        { timeout: 90_000 },
      );
      // Each write is attempted exactly once. Unknown outcomes terminate, never resend.
      const [, created, accepted] = await Promise.all([
        page.getByRole('button', { name: '发送消息', exact: true }).click(),
        createdResponse,
        acceptedResponse,
      ]);
      let activeSession = session;
      if (created) activeSession = (await created.json()).data;
      if (
        !record(activeSession) ||
        !sessionId(activeSession.sessionHandle) ||
        activeSession.releaseRef !== releaseRef ||
        activeSession.state !== 'active' ||
        !timestamp(activeSession.createdAt)
      )
        fail('UNVERIFIED_CONSUMER_SESSION');
      const request = accepted.request().postDataJSON();
      if (
        !exactKeys(request, ['clientMessageId', 'content']) ||
        !opaque(request.clientMessageId) ||
        request.content !== syntheticRetailScenario.question ||
        new URL(accepted.url()).pathname !==
          `/api/v1/public/sessions/${activeSession.sessionHandle}/messages`
      )
        fail('UNVERIFIED_CONSUMER_REQUEST');
      const turn = checkedAcceptedTurn(
        (await accepted.json()).data,
        activeSession.sessionHandle,
        options.origin,
      );
      await expect(bubbles).toHaveCount(priorCount + 1, { timeout: 90_000 });
      const completed = checkedCompletedTurn(await readJson(page, turn.path), {
        sessionHandle: activeSession.sessionHandle,
        ...turn,
        clientMessageId: request.clientMessageId,
        question: syntheticRetailScenario.question,
      });
      const answer = answerForEvidence(completed, secrets);
      await expect(bubbles.last()).toHaveText(answer);
      return { session: activeSession, answer };
    };
    const manualGate = async (phase, evidence) => {
      const challenge = `r1_${randomBytes(8).toString('hex')}`;
      output({
        type: 'manual_review_required',
        phase,
        synthetic: true,
        evidence,
        qualityVerdict: 'requires_human_review',
        instruction: `核对合成事实和实际回答。仅输入 pass ${challenge} 才继续；输入 abort 或超时即停止，不会自动重复写入或模型调用。`,
      });
      await waitForManualDecision(input, { challenge, timeoutMs: options.reviewTimeoutMs });
      output({ type: 'manual_review_recorded', phase, verdict: 'pass', synthetic: true });
    };

    step = 'operator-login';
    const operatorPage = await (await newPrivateContext()).newPage();
    await goto(operatorPage, '/ops/login');
    await operatorPage.getByLabel('运营账号', { exact: true }).fill(options.username);
    await operatorPage.getByLabel('密码', { exact: true }).fill(options.password);
    await operatorPage.getByRole('button', { name: '登录运营后台', exact: true }).click();
    await expect(operatorPage.getByRole('heading', { name: '生成商家后台领取链接' })).toBeVisible();
    verifyPage(operatorPage);

    step = 'merchant-provision';
    const suffix = randomBytes(5).toString('hex');
    const merchantName = `合成电商验收商家 ${suffix}`;
    const assistantName = `合成保温杯客服 ${suffix}`;
    await operatorPage.getByLabel('商家名称', { exact: true }).fill(merchantName);
    await operatorPage.getByRole('button', { name: '创建商家并生成领取链接', exact: true }).click();
    const setupOutput = operatorPage.locator('.ops-created output');
    await expect(setupOutput).toBeVisible();
    const setupUrl = checkedStagingLink(await setupOutput.textContent(), options.origin, 'setup');
    secrets.push(setupUrl.hash.slice(1));

    step = 'merchant-claim';
    const merchantPage = await (await newPrivateContext()).newPage();
    await goto(merchantPage, `${setupUrl.pathname}${setupUrl.hash}`);
    const merchantPassword = randomBytes(24).toString('base64url');
    const merchantPhone = `1990000${String(randomInt(0, 10_000)).padStart(4, '0')}`;
    secrets.push(merchantPassword, merchantPhone);
    await expect(
      merchantPage.getByRole('button', { name: '领取商家后台', exact: true }),
    ).toBeEnabled();
    await merchantPage.getByLabel('负责人手机号', { exact: true }).fill(merchantPhone);
    await merchantPage
      .getByLabel('平台登录密码（至少 12 位）', { exact: true })
      .fill(merchantPassword);
    await merchantPage.getByRole('button', { name: '领取商家后台', exact: true }).click();
    await expect(merchantPage).toHaveURL(
      new RegExp(`^${options.origin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/[0-9a-f]{32}$`, 'u'),
    );
    const merchantId = new URL(merchantPage.url()).pathname.slice(1);
    if (!hexId(merchantId)) fail('UNVERIFIED_MERCHANT');

    step = 'draft-create';
    await goto(merchantPage, `/${merchantId}/drafts`);
    for (const [label, value] of [
      ['客服名称', assistantName],
      ['细分行业', syntheticRetailScenario.industry],
      ['业务范围', syntheticRetailScenario.businessScope],
      ['商品或服务资料', syntheticRetailScenario.materialsSummary],
      ['价格与条件', syntheticRetailScenario.pricingSummary],
      ['优惠与售卖策略', syntheticRetailScenario.promotionSummary],
      ['欢迎语', syntheticRetailScenario.welcomeMessage],
      ['资料不足时的回复', syntheticRetailScenario.insufficientInfoMessage],
      ['人工联系说明（可选）', syntheticRetailScenario.humanContact],
    ])
      await merchantPage.getByLabel(label, { exact: true }).fill(value);
    await merchantPage.getByRole('button', { name: '创建客服草稿', exact: true }).click();
    await expect(
      merchantPage.getByText(`已创建客服草稿「${assistantName}」。`, { exact: true }),
    ).toBeVisible();
    await merchantPage.getByRole('link', { name: '进入客服配置、试聊和发布', exact: true }).click();
    await expect(merchantPage).toHaveURL(
      new RegExp(
        `^${options.origin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/${merchantId}/drafts/[0-9a-f]{32}$`,
        'u',
      ),
    );
    const assistantId = new URL(merchantPage.url()).pathname.split('/').at(-1);
    if (!hexId(assistantId)) fail('UNVERIFIED_ASSISTANT');
    await expect(
      merchantPage.getByRole('heading', { name: assistantName, exact: true }),
    ).toBeVisible();

    step = 'baseline-confirm';
    await confirmMaterials(merchantPage, merchantId, assistantId);
    step = 'baseline-preview';
    await goto(merchantPage, `/${merchantId}/publish/${assistantId}`);
    await merchantPage
      .getByLabel('试聊问题', { exact: true })
      .fill(syntheticRetailScenario.previewQuestion);
    await merchantPage.getByRole('button', { name: '发送测试问题', exact: true }).click();
    const preview = merchantPage.locator('.assistant-preview-answer > p');
    await expect(preview).toBeVisible({ timeout: 90_000 });
    const baselinePreview = answerForEvidence(await preview.textContent(), secrets);

    step = 'baseline-publish';
    const publicUrl = await publish(merchantPage, merchantId, assistantId, 1);
    const publicSlug = publicUrl.pathname.slice('/a/'.length);
    const consumerPage = await (await newPrivateContext()).newPage();
    await goto(consumerPage, publicUrl.pathname);
    await expect(
      consumerPage.getByRole('heading', { name: assistantName, exact: true }),
    ).toBeVisible();
    const originalSnapshot = await readJson(
      consumerPage,
      `/api/v1/public/assistants/${publicSlug}`,
    );
    if (
      originalSnapshot.publicAssistantId !== publicSlug ||
      originalSnapshot.assistantDisplayName !== assistantName ||
      originalSnapshot.merchantDisplayName !== merchantName ||
      !hexId(originalSnapshot.releaseRef) ||
      originalSnapshot.humanContact !== syntheticRetailScenario.humanContact
    )
      fail('UNVERIFIED_PUBLISHED_SNAPSHOT');
    await consumerPage.getByText('联系商家 / 人工服务', { exact: true }).click();
    await expect(
      consumerPage.getByText(syntheticRetailScenario.humanContact, { exact: true }),
    ).toBeVisible();
    await expect(consumerPage.getByText(/此处不实时转接/u)).toBeVisible();

    step = 'consumer-original-question';
    const before = await sendQuestion(consumerPage, {
      publicSlug,
      session: null,
      releaseRef: originalSnapshot.releaseRef,
    });
    step = 'improvement-from-source';
    const sourceSessionId = before.session.sessionHandle.slice(2);
    await goto(merchantPage, `/${merchantId}/conversations/${sourceSessionId}`);
    const source = merchantPage.locator('.merchant-conversation-messages > li').filter({
      has: merchantPage.getByText(syntheticRetailScenario.question, { exact: true }),
    });
    await expect(source).toHaveCount(1);
    await source.getByRole('link', { name: '改进这条回答', exact: true }).click();
    await expect(merchantPage.getByLabel('消费者问题或测试问题', { exact: true })).toHaveValue(
      syntheticRetailScenario.question,
    );
    await merchantPage
      .getByLabel('商家期望答案（真实有效的事实和处理方式）', { exact: true })
      .fill(syntheticRetailScenario.correctedAnswer);
    await merchantPage
      .getByLabel('商家备注（仅用于任务管理，不发送给模型）', { exact: true })
      .fill(
        '全部资料为虚构合成资料。已为本次验收确认新疆单件运费15元，不参加满99包邮，其他数量另确认。',
      );
    await merchantPage.getByRole('button', { name: '建立改进任务', exact: true }).click();
    await expect(merchantPage).toHaveURL(
      /\/[0-9a-f]{32}\/improvements\/[0-9a-f]{32}\?assistant=[0-9a-f]{32}$/u,
    );
    verifyPage(merchantPage);
    const improvementUrl = new URL(merchantPage.url());
    const improvementId = improvementUrl.pathname.split('/').at(-1);
    if (!hexId(improvementId) || improvementUrl.searchParams.get('assistant') !== assistantId)
      fail('UNVERIFIED_IMPROVEMENT');
    await expect(merchantPage.getByText(before.answer, { exact: true })).toBeVisible();
    await merchantPage.getByLabel(/已核对真实事实和适用条件/u).check();
    await merchantPage.getByRole('button', { name: '应用修正到草稿 FAQ', exact: true }).click();
    await expect(merchantPage.getByText(/修正已写入草稿修订/u)).toBeVisible();
    // Read-only reload verifies persistence; it never replays the write or model call.
    await goto(merchantPage, `${improvementUrl.pathname}${improvementUrl.search}`);
    await expect(merchantPage.locator('pre[aria-label="拟写入草稿的 FAQ"]')).toContainText(
      syntheticRetailScenario.correctedAnswer,
    );
    const appliedRevisionText = await merchantPage
      .locator('.improvement-detail')
      .first()
      .textContent();
    const revision = /任务版本\s+(\d+)\s+·\s+当前草稿修订\s+(\d+)/u.exec(appliedRevisionText ?? '');
    if (!revision) fail('UNVERIFIED_IMPROVEMENT_REVISION');
    const versions = {
      improvementRef: improvementId,
      taskVersion: Number(revision[1]),
      draftRevision: Number(revision[2]),
      originalReleaseRef: originalSnapshot.releaseRef,
    };

    step = 'improvement-real-retest';
    await merchantPage.getByLabel(/同意将当前草稿的业务资料和本条问题/u).check();
    await merchantPage.getByRole('button', { name: '发送问题并记录复测', exact: true }).click();
    const passButton = merchantPage.getByRole('button', {
      name: '符合预期，判定通过',
      exact: true,
    });
    await expect(passButton).toBeEnabled({ timeout: 90_000 });
    const run = merchantPage.locator('.improvement-run').first();
    await expect(run.getByText('调用完成，待商家判定。', { exact: true })).toBeVisible();
    const correctedPreview = answerForEvidence(
      await run.locator(':scope > p.improvement-answer').textContent(),
      secrets,
    );
    const runId = await run.locator('input[name="runId"]').inputValue();
    if (!hexId(runId)) fail('UNVERIFIED_EVALUATION_RUN');

    step = 'manual-review-before-publish';
    await manualGate('corrected_draft', {
      question: syntheticRetailScenario.question,
      baselinePreview: {
        question: syntheticRetailScenario.previewQuestion,
        answer: baselinePreview,
      },
      originalConsumerAnswer: before.answer,
      correctedDraftAnswer: correctedPreview,
      beforeCriteria: syntheticRetailScenario.beforeCriteria,
      afterCriteria: syntheticRetailScenario.afterCriteria,
      ...versions,
      evaluationRunRef: runId,
    });
    step = 'manual-verdict-save';
    await passButton.click();
    await expect(run.getByText('商家已判定通过。', { exact: true })).toBeVisible();
    step = 'corrected-materials-confirm';
    await confirmMaterials(merchantPage, merchantId, assistantId);
    step = 'corrected-publish';
    const nextPublicUrl = await publish(merchantPage, merchantId, assistantId, 2);
    if (nextPublicUrl.href !== publicUrl.href) fail('PUBLIC_LINK_CHANGED');
    await goto(merchantPage, `${improvementUrl.pathname}${improvementUrl.search}`);
    await expect(
      merchantPage.getByText('本条改进已关联当前线上版本。', { exact: false }),
    ).toBeVisible();

    step = 'old-session-preserved';
    await goto(consumerPage, publicUrl.pathname);
    checkedSessionHistory(
      await readJson(
        consumerPage,
        `/api/v1/public/sessions/${before.session.sessionHandle}/history`,
      ),
      {
        sessionHandle: before.session.sessionHandle,
        releaseRef: originalSnapshot.releaseRef,
        requiredAnswer: before.answer,
      },
    );
    await expect(
      consumerPage.locator('.message-row--assistant .message-bubble p').last(),
    ).toHaveText(before.answer);
    const oldContinued = await sendQuestion(consumerPage, {
      publicSlug,
      session: before.session,
      releaseRef: originalSnapshot.releaseRef,
    });

    step = 'new-session-current-release';
    const newConsumerPage = await (await newPrivateContext()).newPage();
    await goto(newConsumerPage, publicUrl.pathname);
    await expect(
      newConsumerPage.getByRole('heading', { name: assistantName, exact: true }),
    ).toBeVisible();
    const nextSnapshot = await readJson(newConsumerPage, `/api/v1/public/assistants/${publicSlug}`);
    if (
      !hexId(nextSnapshot.releaseRef) ||
      nextSnapshot.releaseRef === originalSnapshot.releaseRef ||
      nextSnapshot.publicAssistantId !== publicSlug ||
      nextSnapshot.assistantDisplayName !== assistantName ||
      nextSnapshot.merchantDisplayName !== merchantName ||
      nextSnapshot.humanContact !== syntheticRetailScenario.humanContact
    )
      fail('NEW_RELEASE_NOT_VERIFIED');
    const after = await sendQuestion(newConsumerPage, {
      publicSlug,
      session: null,
      releaseRef: nextSnapshot.releaseRef,
    });
    if (after.session.sessionHandle === before.session.sessionHandle)
      fail('CONSUMER_SESSION_REUSED');
    checkedSessionHistory(
      await readJson(
        newConsumerPage,
        `/api/v1/public/sessions/${after.session.sessionHandle}/history`,
      ),
      {
        sessionHandle: after.session.sessionHandle,
        releaseRef: nextSnapshot.releaseRef,
        requiredAnswer: after.answer,
      },
    );
    // The real H5 decoder must accept and restore this persisted history too;
    // checking a server JSON reference alone is not a usable-session proof.
    const restoredResponse = await newConsumerPage.reload();
    verifyPage(newConsumerPage);
    if (restoredResponse?.status() !== 200) fail('NEW_SESSION_RESTORE_FAILED');
    await expect(
      newConsumerPage.getByRole('heading', { name: assistantName, exact: true }),
    ).toBeVisible();
    await expect(
      newConsumerPage.locator('.message-row--assistant .message-bubble p').last(),
    ).toHaveText(after.answer);
    await expect(
      merchantPage.getByText(`此任务曾关联发布版本：${nextSnapshot.releaseRef}。`, {
        exact: false,
      }),
    ).toBeVisible();
    step = 'manual-review-published-consumer';
    await manualGate('published_consumer', {
      question: syntheticRetailScenario.question,
      oldSessionAnswer: oldContinued.answer,
      oldSessionReleaseRef: originalSnapshot.releaseRef,
      newSessionAnswer: after.answer,
      newSessionReleaseRef: nextSnapshot.releaseRef,
      beforeCriteria: syntheticRetailScenario.beforeCriteria,
      afterCriteria: syntheticRetailScenario.afterCriteria,
      ...versions,
    });
    output({
      type: 'completed',
      environment: 'private_staging',
      synthetic: true,
      workflowState: 'completed',
      qualityVerdict: 'manually_approved',
      modelExecution: modelExecutionBoundary,
      plannedModelCalls: 5,
      ...versions,
      newReleaseRef: nextSnapshot.releaseRef,
      note: '本次合成场景人工验收；此脚本不核验实际模型提供方，需另行关联Worker配置与镜像证据。不是准确率、全量质量结论或公网发布证明；合成商家及验收记录保留在私有staging。',
    });
    return true;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ type: 'stopped', step, code: error instanceof StagingSmokeSafetyError ? error.code : 'UNVERIFIED_STEP_RESULT', automaticRetry: false, qualityVerdict: 'not_passed', syntheticRecordsMayRemain: true })}\n`,
    );
    return false;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    secrets.fill('');
  }
}

const invokedAsCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
      process.stdout.write(
        'Private staging R1 smoke (real browser; requested real model; synthetic data only).\nRequired environment: H5CS_STAGE_ORIGIN=https://127.0.0.1:<port>, H5CS_STAGE_CHROME_PATH=<absolute path>, H5CS_STAGE_OPERATOR_USERNAME, H5CS_STAGE_OPERATOR_PASSWORD, H5CS_STAGE_MODEL_MODE=real, H5CS_STAGE_SYNTHETIC_DATA_CONSENT=true. Optional H5CS_STAGE_REVIEW_TIMEOUT_SECONDS=30..900 (default 300). Actual model provider and isolation require independent Worker configuration and image verification; this script does not certify them. No credentials in arguments. Two fresh manual challenges require pass <challenge> or abort on stdin. No screenshots, trace, stored auth, automatic retries or public deployment.\n',
      );
    } else {
      const options = parseStagingImprovementOptions(process.env, args);
      // Do not pass operator credentials to a browser child through its environment.
      delete process.env.H5CS_STAGE_OPERATOR_USERNAME;
      delete process.env.H5CS_STAGE_OPERATOR_PASSWORD;
      if (!(await runStagingImprovementSmoke(options))) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ type: 'stopped', step: 'parameter_validation', code: error instanceof StagingSmokeSafetyError ? error.code : 'INVALID_PARAMETERS', automaticRetry: false, qualityVerdict: 'not_passed' })}\n`,
    );
    process.exitCode = 1;
  }
}
