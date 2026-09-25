import { randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

test('operator provisions a merchant, merchant publishes, consumer receives an AI reply', async ({
  browser,
}) => {
  const operatorPassword = process.env['H5CS_E2E_OPERATOR_PASSWORD'];
  if (!operatorPassword) throw new Error('Browser-test operator credential is unavailable');

  const merchantName = `浏览器测试商家 ${randomBytes(5).toString('hex')}`;
  const assistantName = `空调清洗客服 ${randomBytes(4).toString('hex')}`;
  const merchantPassword = randomBytes(24).toString('base64url');

  const operatorPage = await browser.newPage();
  await operatorPage.goto('http://127.0.0.1:3002/');
  await expect(operatorPage).toHaveURL('http://127.0.0.1:3002/login');
  await operatorPage.getByLabel('运营账号').fill('browser_test_operator');
  await operatorPage.getByLabel('密码').fill(operatorPassword);
  await operatorPage.getByRole('button', { name: '登录运营后台' }).click();
  try {
    await expect(operatorPage).toHaveURL('http://127.0.0.1:3002/', { timeout: 10_000 });
  } catch {
    const error = await operatorPage
      .getByRole('alert')
      .textContent()
      .catch(() => null);
    throw new Error(`Operator login did not complete: ${error ?? 'no page error was shown'}`);
  }
  await expect(operatorPage.getByRole('heading', { name: '生成商家后台领取链接' })).toBeVisible();
  await operatorPage.getByLabel('商家名称').fill(merchantName);
  await operatorPage.getByRole('button', { name: '创建商家并生成领取链接' }).click();
  const setupLink = operatorPage.locator('.ops-created output');
  await expect(setupLink).toBeVisible();
  const setupUrl = new URL((await setupLink.textContent())!);
  expect(setupUrl.origin).toBe('http://127.0.0.1:3000');
  expect(setupUrl.pathname).toBe('/setup');
  expect(/^#[A-Za-z0-9_-]{43}$/u.test(setupUrl.hash)).toBe(true);

  const merchantPage = await browser.newPage();
  await merchantPage.evaluate((token) => {
    window.location.replace(`http://127.0.0.1:3000/setup#${token}`);
  }, setupUrl.hash.slice(1));
  await expect(merchantPage.getByRole('button', { name: '领取商家后台' })).toBeEnabled();
  await merchantPage.getByLabel('负责人手机号').fill('13700137000');
  await merchantPage.getByLabel('平台登录密码（至少 12 位）').fill(merchantPassword);
  await merchantPage.getByRole('button', { name: '领取商家后台' }).click();
  await expect(merchantPage).toHaveURL(/\/workspace\/[0-9a-f]{32}$/u);
  const managementUrl = merchantPage.url();
  await operatorPage.reload();
  await expect(operatorPage.getByRole('link', { name: managementUrl })).toHaveAttribute(
    'href',
    managementUrl,
  );

  await merchantPage.getByLabel('客服名称').fill(assistantName);
  await merchantPage.getByLabel('细分行业').fill('家电清洗');
  await merchantPage.getByLabel('业务范围').fill('提供家用空调清洗咨询');
  await merchantPage.getByLabel('商品或服务资料').fill('提供上门空调清洗服务');
  await merchantPage.getByLabel('价格与条件').fill('价格需联系商家确认');
  await merchantPage.getByLabel('优惠与售卖策略').fill('目前无已确认优惠');
  await merchantPage.getByLabel('欢迎语').fill('您好，我是 AI 客服。');
  await merchantPage.getByLabel('资料不足时的回复').fill('资料不足，请联系商家核实。');
  await merchantPage.getByRole('button', { name: '创建客服草稿' }).click();
  await expect(merchantPage.getByText(`已创建客服草稿「${assistantName}」`)).toBeVisible();
  await merchantPage.reload();
  await merchantPage.getByRole('link', { name: assistantName }).click();
  await expect(merchantPage.getByRole('heading', { name: assistantName })).toBeVisible();
  await merchantPage.getByLabel(/我已逐项核对以上资料/u).check();
  await merchantPage.getByRole('button', { name: '确认当前草稿资料' }).click();
  await expect(merchantPage.getByText('当前草稿资料已确认')).toBeVisible();
  await merchantPage.reload();
  await expect(merchantPage.getByRole('button', { name: '确认发布 AI 客服' })).toBeEnabled();
  await expect(merchantPage.getByRole('img', { name: '扫码打开消费者 AI 客服' })).toHaveCount(0);
  await merchantPage.getByLabel(/我确认发布当前修订/u).check();
  await merchantPage.getByRole('button', { name: '确认发布 AI 客服' }).click();
  const publicLink = merchantPage.locator('a[href^="http://127.0.0.1:3001/a/"]').first();
  await expect(publicLink).toBeVisible();
  const publicUrl = await publicLink.getAttribute('href');
  expect(publicUrl).toMatch(/^http:\/\/127\.0\.0\.1:3001\/a\/[a-z0-9-]+$/u);
  const shareQr = merchantPage.getByRole('img', { name: '扫码打开消费者 AI 客服' }).first();
  await expect(shareQr).toBeVisible();
  await expect(shareQr).toHaveAttribute('src', /^data:image\/png;base64,/u);
  await expect(merchantPage.getByRole('link', { name: '下载二维码' }).first()).toHaveAttribute(
    'download',
    /^ai-customer-service-[a-z0-9-]+\.png$/u,
  );

  const consumerPage = await browser.newPage();
  await consumerPage.goto(publicUrl!);
  await expect(consumerPage.getByRole('heading', { name: assistantName })).toBeVisible();
  await consumerPage.getByRole('textbox', { name: '输入想咨询的问题' }).fill('你们提供什么服务？');
  await consumerPage.getByRole('button', { name: '发送消息' }).click();
  const answer = consumerPage.getByText(
    '我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。',
  );
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await consumerPage.reload();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  consumerPage.once('dialog', (dialog) => void dialog.accept());
  await consumerPage.getByRole('button', { name: '新建咨询' }).click();
  await expect(answer).toHaveCount(0);
});
