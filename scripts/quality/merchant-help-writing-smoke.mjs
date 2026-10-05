import { randomBytes, randomInt } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const origin = process.env.H5CS_HELP_ORIGIN;
const stage = origin === 'https://127.0.0.1:18443';
if (!stage && origin !== 'https://h5cs.1rying.com') throw new Error('Unexpected help test origin');
const password = process.env.H5CS_HELP_OPERATOR_PASSWORD;
delete process.env.H5CS_HELP_OPERATOR_PASSWORD;
if (!password || !process.env.H5CS_HELP_CHROME_PATH) throw new Error('Missing test configuration');
const browser = await chromium.launch({
  executablePath: process.env.H5CS_HELP_CHROME_PATH,
  headless: true,
});
let step = 'operator';
let testPage;
let writingStatus;
const checks = [];
try {
  const opsContext = await browser.newContext({ ignoreHTTPSErrors: stage });
  const ops = await opsContext.newPage();
  await ops.goto(`${origin}/ops`);
  await ops.getByLabel('运营账号').fill(process.env.H5CS_HELP_OPERATOR_USERNAME ?? 'admin');
  await ops.getByLabel('密码').fill(password);
  await ops.getByRole('button', { name: '登录运营后台' }).click();
  await expect(ops.getByRole('heading', { name: '生成商家后台领取链接' })).toBeVisible({
    timeout: 30000,
  });
  await ops.getByLabel('商家名称').fill(`帮助填写助手合成测试 ${randomBytes(4).toString('hex')}`);
  await ops.getByRole('button', { name: '创建商家并生成领取链接' }).click();
  const setup = ops.locator('.ops-created output');
  await expect(setup).toBeVisible({ timeout: 30000 });
  const setupUrl = new URL((await setup.textContent()).trim());
  if (
    setupUrl.origin !== origin ||
    setupUrl.pathname !== '/console/setup' ||
    !/^#[A-Za-z0-9_-]{43}$/u.test(setupUrl.hash)
  )
    throw new Error('Invalid setup URL');
  const context = await browser.newContext({ ignoreHTTPSErrors: stage });
  const page = await context.newPage();
  testPage = page;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('/writing/generate'))
      writingStatus = response.status();
  });
  const errors = [];
  page.on('pageerror', () => errors.push('page-error'));
  await page.goto(setupUrl.href);
  await page
    .getByLabel('负责人手机号')
    .fill(`137${String(randomInt(0, 100000000)).padStart(8, '0')}`);
  await page.getByLabel('平台登录密码（至少 12 位）').fill(randomBytes(24).toString('base64url'));
  await page.getByRole('button', { name: '领取商家后台' }).click();
  await expect(page).toHaveURL(/\/[0-9a-f]{32}$/u, { timeout: 30000 });
  const merchantId = new URL(page.url()).pathname.slice(1);
  const nav = page.getByRole('navigation', { name: '商家后台主导航' });
  step = 'help-search-download';
  await nav.getByRole('link', { name: '帮助中心', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/${merchantId}/help`);
  await page.getByLabel('查找操作或问题').fill('二维码');
  await page.locator('#share summary').click();
  await expect(page.locator('#share .help-action')).toHaveAttribute(
    'href',
    `/${merchantId}/publish`,
  );
  await page.getByLabel('查找操作或问题').fill('zz-no-results');
  await expect(page.getByRole('button', { name: '查看全部帮助' })).toBeVisible();
  await page.getByRole('button', { name: '查看全部帮助' }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载使用手册' }).click();
  const download = await downloaded;
  if (download.suggestedFilename() !== '商家AI客服使用手册.txt')
    throw new Error('Manual download must be readable plain text');
  const text = await readFile(await download.path(), 'utf8');
  if (!text.includes('客服资料填写助手') || !text.includes('不会自动保存或发布'))
    throw new Error('Incomplete help manual');
  checks.push('tenant help search, related actions, no-result reset and complete manual download');

  step = 'writing-generated-options';
  await nav.getByRole('link', { name: '资料填写助手', exact: true }).click();
  await expect(page.getByRole('heading', { name: '客服资料填写助手', exact: true })).toBeVisible();
  await page.getByLabel('想要撰写的内容').selectOption('welcomeMessage');
  await page
    .getByLabel('简短描述')
    .fill('合成测试的电商零售店，写一段亲切的 AI 客服欢迎语，引导顾客咨询商品，不承诺价格和优惠。');
  await page.getByRole('button', { name: '生成备选文案' }).click();
  await expect(page.locator('.writing-panel').getByRole('alert')).toContainText('勾选');
  await page.getByLabel(/我同意将此简述/u).check();
  await page.getByRole('button', { name: '生成备选文案' }).click();
  await expect(page.locator('.writing-results article')).toHaveCount(3, { timeout: 40000 });
  const generated = await page
    .locator('.writing-results article')
    .first()
    .locator('textarea')
    .inputValue();
  if (!generated || generated.length > 500 || !/AI|人工智能/u.test(generated))
    throw new Error('Invalid real model suggestions');
  checks.push('real Qwen suggestions with explicit text consent');
  await mkdir('artifacts/help-writing', { recursive: true });
  await page.screenshot({
    path: `artifacts/help-writing/${stage ? 'stage' : 'public'}-writing.png`,
    fullPage: true,
  });

  step = 'field-apply-undo-save';
  await nav.getByRole('link', { name: '客服草稿', exact: true }).click();
  await expect(page.getByRole('button', { name: '帮我写欢迎语', exact: true })).toBeVisible();
  const before = await page.getByLabel('欢迎语', { exact: true }).inputValue();
  const priceBefore = await page.locator('textarea[name="pricingSummary"]').inputValue();
  await page.getByRole('button', { name: '帮我写欢迎语', exact: true }).click();
  const panel = page.getByRole('region', { name: '欢迎语填写助手' });
  step = 'field-generation';
  await panel
    .getByLabel('简短描述')
    .fill('合成测试的零售店，欢迎顾客咨询商品，明确是 AI 客服，语气礼貌。');
  await panel.getByLabel(/我同意将此简述/u).check();
  await panel.getByRole('button', { name: '生成备选文案' }).click();
  await expect(panel.locator('.writing-results article')).toHaveCount(3, { timeout: 40000 });
  const option = panel.locator('.writing-results article').first().locator('textarea');
  const selected = await option.inputValue();
  step = 'field-stale-protection';
  await page.getByLabel('欢迎语', { exact: true }).fill('刚刚手动修改');
  await panel.getByRole('button', { name: '填入此字段' }).first().click();
  await expect(page.locator('.draft-fields > [role="status"]')).toContainText('原字段已被修改');
  await expect(page.getByLabel('欢迎语', { exact: true })).toHaveValue('刚刚手动修改');
  await page.getByLabel('欢迎语', { exact: true }).fill(before);
  step = 'field-apply-undo';
  await panel.getByRole('button', { name: '填入此字段' }).first().click();
  await expect(page.getByLabel('欢迎语', { exact: true })).toHaveValue(selected);
  await expect(page.locator('textarea[name="pricingSummary"]')).toHaveValue(priceBefore);
  await page.getByRole('button', { name: '撤销上次填入' }).click();
  await expect(page.getByLabel('欢迎语', { exact: true })).toHaveValue(before);
  await page.getByLabel('欢迎语', { exact: true }).fill(selected);
  step = 'field-save-reload';
  const name = `填写助手合成客服 ${randomBytes(3).toString('hex')}`;
  await page.getByLabel('客服名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建客服草稿', exact: true }).click();
  await expect(page.locator('.assistant-created-result')).toContainText('已创建客服草稿', {
    timeout: 30000,
  });
  await page.getByRole('link', { name: '进入客服配置、试聊和发布' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.locator('input[name="welcomeMessage"]')).toHaveValue(selected);
  await expect(
    page.getByRole('button', { name: '帮我写商品或服务资料', exact: true }),
  ).toBeVisible();
  checks.push(
    'all-field entry, current-text protection, selective apply, undo and persisted real draft',
  );

  step = 'isolation-csrf';
  const denial = await page.evaluate(
    async ({ target, own }) => {
      const csrf =
        document.cookie
          .split('; ')
          .find((value) => value.startsWith('__Host-h5cs-csrf='))
          ?.split('=')[1] ?? '';
      const body = JSON.stringify({
        field: 'welcomeMessage',
        brief: '合成测试',
        currentText: '',
        consent: true,
      });
      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-h5cs-csrf': csrf },
        body,
      };
      return [
        (await fetch(`/${target}/writing/generate`, options)).status,
        (
          await fetch(`/${own}/writing/generate`, {
            ...options,
            headers: { 'Content-Type': 'application/json', 'x-h5cs-csrf': 'invalid' },
          })
        ).status,
      ];
    },
    { target: 'b35bf7e4d02550f384384535952266d3', own: merchantId },
  );
  if (denial.some((status) => status !== 403)) throw new Error('Writing boundary not denied');
  for (const section of ['help', 'writing']) {
    await page.goto(`${origin}/b35bf7e4d02550f384384535952266d3/${section}`);
    await expect(page.getByRole('heading', { name: '登录商家管理后台' })).toBeVisible();
  }
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: stage });
  const anon = await anonymous.newPage();
  await anon.goto(`${origin}/${merchantId}/help`);
  await expect(anon.getByRole('heading', { name: '登录商家管理后台' })).toBeVisible();
  checks.push('anonymous, cross-merchant and invalid-CSRF denied');

  step = 'mobile-help';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/${merchantId}/help#writing`);
  await expect(page.locator('#writing')).toHaveAttribute('open', '');
  await expect(
    page
      .getByRole('navigation', { name: '商家后台主导航' })
      .getByRole('link', { name: '帮助中心', exact: true }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (overflow) throw new Error('Mobile help horizontal overflow');
  await page.screenshot({
    path: `artifacts/help-writing/${stage ? 'stage' : 'public'}-help-mobile.png`,
    fullPage: true,
  });
  if (errors.length) throw new Error('Client runtime errors');
  checks.push('mobile navigation, contextual article opening and no horizontal overflow');
  console.log(
    JSON.stringify({ status: 'passed', environment: stage ? 'staging' : 'controlled-web', checks }),
  );
} catch (error) {
  if (step === 'writing-generated-options' || step.startsWith('field-')) {
    console.error(
      JSON.stringify({
        type: error.name,
        writingStatus,
        resultCount: await testPage.locator('.writing-results article').count(),
        alerts: await testPage.locator('.writing-panel [role="alert"]').allTextContents(),
      }),
    );
  }
  console.error(`Help/writing smoke failed at ${step}; no credentials or private links logged.`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
