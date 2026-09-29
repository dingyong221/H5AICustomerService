import { randomBytes, randomInt } from 'node:crypto';

import { chromium, expect } from '@playwright/test';

const origin = process.env.H5CS_STAGE_ORIGIN;
const operatorUsername = process.env.H5CS_STAGE_OPERATOR_USERNAME;
const operatorPassword = process.env.H5CS_STAGE_OPERATOR_PASSWORD;
const chromePath = process.env.H5CS_STAGE_CHROME_PATH;
const modelMode = process.env.H5CS_STAGE_MODEL_MODE ?? 'fake';
delete process.env.H5CS_STAGE_OPERATOR_PASSWORD;

if (!origin || !operatorUsername || !operatorPassword || !chromePath) {
  throw new Error('Staging browser smoke requires an origin, operator credentials and Chrome');
}
if (modelMode !== 'fake' && modelMode !== 'real') {
  throw new Error('Staging browser smoke model mode must be fake or real');
}
const parsedOrigin = new URL(origin);
if (
  parsedOrigin.origin !== origin ||
  parsedOrigin.protocol !== 'https:' ||
  parsedOrigin.hostname !== '127.0.0.1' ||
  !parsedOrigin.port
) {
  throw new Error('Staging browser smoke accepts only an explicit loopback HTTPS origin');
}

let browser;
let step = 'launch';
try {
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const operatorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const operatorPage = await operatorContext.newPage();

  step = 'operator-login';
  await operatorPage.goto(`${origin}/ops/`);
  await operatorPage.getByLabel('运营账号').fill(operatorUsername);
  await operatorPage.getByLabel('密码').fill(operatorPassword);
  await operatorPage.getByRole('button', { name: '登录运营后台' }).click();
  await expect(operatorPage.getByRole('heading', { name: '生成商家后台领取链接' })).toBeVisible({
    timeout: 30_000,
  });

  step = 'merchant-provision';
  const merchantName = `服务器验收商家 ${randomBytes(5).toString('hex')}`;
  await operatorPage.getByLabel('商家名称').fill(merchantName);
  await operatorPage.getByRole('button', { name: '创建商家并生成领取链接' }).click();
  const setupOutput = operatorPage.locator('.ops-created output');
  await expect(setupOutput).toBeVisible({ timeout: 30_000 });
  const setupUrl = new URL((await setupOutput.textContent())?.trim() ?? '');
  if (
    setupUrl.origin !== origin ||
    setupUrl.pathname !== '/console/setup' ||
    !/^#[A-Za-z0-9_-]{43}$/u.test(setupUrl.hash)
  ) {
    throw new Error('The one-time setup URL did not match the staging origin');
  }

  step = 'merchant-claim';
  const merchantContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const merchantPage = await merchantContext.newPage();
  await merchantPage.goto(setupUrl.toString());
  await expect(merchantPage.getByRole('button', { name: '领取商家后台' })).toBeEnabled({
    timeout: 30_000,
  });
  await merchantPage
    .getByLabel('负责人手机号')
    .fill(`137${String(randomInt(0, 100_000_000)).padStart(8, '0')}`);
  await merchantPage
    .getByLabel('平台登录密码（至少 12 位）')
    .fill(randomBytes(24).toString('base64url'));
  await merchantPage.getByRole('button', { name: '领取商家后台' }).click();
  await expect(merchantPage).toHaveURL(/\/console\/workspace\/[0-9a-f]{32}$/u, {
    timeout: 30_000,
  });

  step = 'assistant-draft';
  const assistantName = `测试客服 ${randomBytes(4).toString('hex')}`;
  await merchantPage.getByLabel('客服名称').fill(assistantName);
  await merchantPage.getByLabel('细分行业').fill('家电清洗');
  await merchantPage.getByLabel('业务范围').fill('提供家用空调清洗咨询');
  await merchantPage.getByLabel('商品或服务资料').fill('提供上门空调清洗服务');
  await merchantPage.getByLabel('价格与条件').fill('价格需联系商家确认');
  await merchantPage.getByLabel('优惠与售卖策略').fill('目前无已确认优惠');
  await merchantPage.getByLabel('欢迎语').fill('您好，我是 AI 客服。');
  await merchantPage.getByLabel('资料不足时的回复').fill('资料不足，请联系商家核实。');
  await merchantPage.getByRole('button', { name: '创建客服草稿' }).click();
  await expect(merchantPage.getByText(/已创建客服草稿/u)).toBeVisible({ timeout: 30_000 });

  step = 'assistant-open';
  await merchantPage.getByRole('link', { name: assistantName }).click();
  await expect(merchantPage.getByRole('heading', { name: assistantName })).toBeVisible();
  step = 'assistant-confirm-materials';
  await merchantPage.getByLabel(/我已逐项核对以上资料/u).check();
  await merchantPage.getByRole('button', { name: '确认当前草稿资料' }).click();
  await expect(merchantPage.getByText('当前草稿资料已确认')).toBeVisible();
  await merchantPage.reload();
  step = 'assistant-publish-ready';
  await expect(merchantPage.getByRole('button', { name: '确认发布 AI 客服' })).toBeEnabled();
  step = 'assistant-publish-submit';
  await merchantPage.getByLabel(/我确认发布当前修订/u).check();
  await merchantPage.getByRole('button', { name: '确认发布 AI 客服' }).click();
  step = 'assistant-public-link';
  const publicLink = merchantPage.locator(`a[href^="${origin}/a/"]`).first();
  await expect(publicLink).toBeVisible({ timeout: 30_000 });
  const publicUrl = new URL((await publicLink.getAttribute('href')) ?? '');
  if (publicUrl.origin !== origin || !/^\/a\/[a-z0-9-]+$/u.test(publicUrl.pathname)) {
    throw new Error('The consumer URL did not match the staging origin');
  }

  step = 'consumer-open';
  const consumerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const consumerPage = await consumerContext.newPage();
  const consumerResponse = await consumerPage.goto(publicUrl.toString());
  if (consumerResponse?.status() !== 200) {
    throw new Error('The consumer page did not return HTTP 200');
  }
  step = 'consumer-heading';
  await expect(consumerPage.getByRole('heading', { name: assistantName })).toBeVisible();
  step = 'consumer-send';
  const assistantMessages = consumerPage.locator('.message-row--assistant .message-bubble p');
  const assistantMessageCount = await assistantMessages.count();
  await consumerPage.getByRole('textbox', { name: '输入想咨询的问题' }).fill('你们提供什么服务？');
  await consumerPage.getByRole('button', { name: '发送消息' }).click();
  step = 'consumer-answer';
  if (modelMode === 'fake') {
    await expect(
      consumerPage.getByText('我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。'),
    ).toBeVisible({ timeout: 90_000 });
  } else {
    await expect(assistantMessages).toHaveCount(assistantMessageCount + 1, { timeout: 90_000 });
    const answer = (await assistantMessages.last().textContent())?.trim();
    if (!answer || answer.length < 8 || answer.length > 10_000) {
      throw new Error('Real-model reply is empty or outside expected bounds');
    }
  }

  process.stdout.write(
    `Staging browser smoke passed (${modelMode} model): operator login, merchant provision and claim, assistant publish, consumer AI reply.\n`,
  );
} catch {
  process.stderr.write(
    `Staging browser smoke failed at ${step}; no credentials or links logged.\n`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
