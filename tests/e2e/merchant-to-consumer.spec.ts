import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

type PublishedReleaseReadback = { status: number; releaseRef: string | null };

async function openMerchantDetails(page: Page, label: string): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: label });
  await expect(summary).toHaveCount(1);
  if (!(await summary.evaluate((element) => element.parentElement?.hasAttribute('open'))))
    await summary.click();
}

async function expectMerchantStep(page: Page, title: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '客服发布步骤' }).getByRole('link', {
      name: new RegExp(`^${title}`, 'u'),
    }),
  ).toHaveAttribute('aria-current', 'step');
}

async function readPublishedRelease(
  page: Page,
  publicUrl: string,
): Promise<PublishedReleaseReadback> {
  const target = new URL(publicUrl);
  if (
    target.origin !== 'http://127.0.0.1:3001' ||
    !/^\/a\/[a-z0-9-]+$/u.test(target.pathname) ||
    target.search ||
    target.hash
  )
    throw new Error('Public release readback requires the synthetic loopback assistant');
  const response = await page.request.get(
    target.origin + '/api/v1/public/assistants/' + target.pathname.slice(3),
    { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } },
  );
  if (response.status() !== 200) return { status: response.status(), releaseRef: null };
  const payload: unknown = await response.json();
  const releaseRef =
    typeof payload === 'object' &&
    payload !== null &&
    'data' in payload &&
    typeof payload.data === 'object' &&
    payload.data !== null &&
    'releaseRef' in payload.data
      ? payload.data.releaseRef
      : null;
  return {
    status: response.status(),
    releaseRef:
      typeof releaseRef === 'string' && /^[0-9a-f]{32}$/u.test(releaseRef) ? releaseRef : null,
  };
}

function safePublicationAlert(text: string): string {
  const line = text.split(/\r?\n/u).find((value) => value.trim()) ?? '';
  if (/\b(?:cookie|authorization|set-cookie|headers?)\s*:/iu.test(line))
    return '[redacted header diagnostic]';
  return line
    .replace(/https?:\/\/\S+/giu, '[redacted URL]')
    .replace(/[A-Za-z0-9_+\/=.%-]{20,}/gu, '[redacted token]')
    .slice(0, 240);
}

test('operator provisions a merchant, merchant previews and publishes, consumer receives an AI reply', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const operatorPassword = process.env['H5CS_E2E_OPERATOR_PASSWORD'];
  if (!operatorPassword) throw new Error('Browser-test operator credential is unavailable');

  const merchantName = `浏览器测试商家 ${randomBytes(5).toString('hex')}`;
  const assistantName = `空调清洗客服 ${randomBytes(4).toString('hex')}`;
  const industryCode = `local_${randomBytes(5).toString('hex')}`;
  const referenceNotes = '参考提示：请核实上门范围，不得把测试价格当成商家报价。';
  const merchantPassword = randomBytes(24).toString('base64url');
  const pathMode = process.env['H5CS_E2E_PATH_MODE'];
  const prefixed = pathMode !== undefined && pathMode !== 'root';
  const sameOrigin = pathMode === 'single_domain';
  const merchantOrigin = `http://127.0.0.1:${sameOrigin ? '3001' : '3000'}`;
  const operatorOrigin = `http://127.0.0.1:${sameOrigin ? '3001' : '3002'}`;
  const merchantBase = `${merchantOrigin}${prefixed ? '/console' : ''}`;
  const operatorBase = `${operatorOrigin}${prefixed ? '/ops' : ''}`;
  const merchantPhone = `137${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
  const sharedContext = sameOrigin ? await browser.newContext() : null;

  const operatorPage = sharedContext ? await sharedContext.newPage() : await browser.newPage();
  await operatorPage.goto(`${operatorBase}/`);
  await expect(operatorPage).toHaveURL(`${operatorBase}/login`);
  await operatorPage.getByLabel('运营账号').fill('browser_test_operator');
  await operatorPage.getByLabel('密码').fill(operatorPassword);
  const loginStartedAt = Date.now();
  const loginResponsePromise = operatorPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${prefixed ? '/ops' : ''}/login`,
    { timeout: 60_000 },
  );
  await operatorPage.getByRole('button', { name: '登录运营后台' }).click();
  const loginResponse = await loginResponsePromise;
  if (loginResponse.status() >= 400)
    throw new Error(`Operator login request returned HTTP ${loginResponse.status()}`);
  try {
    await expect(operatorPage).toHaveURL(
      sameOrigin
        ? /^http:\/\/127\.0\.0\.1:3001\/ops\/?$/u
        : prefixed
          ? /^http:\/\/127\.0\.0\.1:3002\/ops\/?$/u
          : 'http://127.0.0.1:3002/',
      { timeout: 30_000 },
    );
  } catch {
    const error = await operatorPage
      .getByRole('alert')
      .textContent()
      .catch(() => null);
    throw new Error(
      `Operator login did not complete at ${operatorPage.url()}: ${error ?? 'no page error was shown'}`,
    );
  }
  process.stdout.write(`Operator login completed in ${Date.now() - loginStartedAt} ms.\n`);
  await expect(operatorPage.getByRole('heading', { name: '生成商家后台领取链接' })).toBeVisible();
  await operatorPage.getByLabel('行业代码').fill(industryCode);
  await operatorPage.getByLabel('行业名称').fill('本地生活服务');
  await operatorPage.getByLabel('行业参考说明').fill(referenceNotes);
  await operatorPage.getByLabel('应收集的产品/服务资料（每行一项）').fill('服务项目\n上门范围');
  await operatorPage.getByLabel('应确认的售卖策略（每行一项，可留空）').fill('价格条件\n优惠期限');
  await operatorPage.getByRole('button', { name: '创建行业模板' }).click();
  await expect(operatorPage.getByText('已创建行业模板 本地生活服务 v1')).toBeVisible();
  await operatorPage.getByLabel('商家名称').fill(merchantName);
  await operatorPage.getByRole('button', { name: '创建商家并生成领取链接' }).click();
  const setupLink = operatorPage.locator('.ops-created output');
  await expect(setupLink).toBeVisible();
  const setupUrl = new URL((await setupLink.textContent())!);
  expect(setupUrl.origin).toBe(merchantOrigin);
  expect(setupUrl.pathname).toBe(`${prefixed ? '/console' : ''}/setup`);
  expect(/^#[A-Za-z0-9_-]{43}$/u.test(setupUrl.hash)).toBe(true);

  const merchantPage = sharedContext ? await sharedContext.newPage() : await browser.newPage();
  await merchantPage.evaluate(
    ([base, token]) => {
      window.location.replace(`${base}/setup#${token}`);
    },
    [merchantBase, setupUrl.hash.slice(1)] as const,
  );
  await expect(merchantPage.getByRole('button', { name: '领取商家后台' })).toBeEnabled();
  await merchantPage.getByLabel('负责人手机号').fill(merchantPhone);
  await merchantPage.getByLabel('平台登录密码（至少 12 位）').fill(merchantPassword);
  await merchantPage.getByRole('button', { name: '领取商家后台' }).click();
  await expect(merchantPage).toHaveURL(/\/[0-9a-f]{32}$/u);
  const managementUrl = merchantPage.url();
  await expect(
    merchantPage.getByRole('link', { name: '进入商家工作台', exact: true }),
  ).toHaveAttribute('href', new URL(managementUrl).pathname);
  await expect(merchantPage.getByRole('link', { name: 'HTTPS 安全绑定' })).toHaveCount(0);
  const merchantNavigation = merchantPage.getByRole('navigation', { name: '商家后台主导航' });
  await openMerchantDetails(merchantPage, 'AI 客服');
  const assistantMenu = merchantNavigation.locator('summary').filter({ hasText: 'AI 客服' });
  await assistantMenu.click();
  await expect(
    merchantNavigation.getByRole('link', { name: '客服列表', exact: true }),
  ).toBeHidden();
  await assistantMenu.focus();
  await assistantMenu.press('Enter');
  await merchantNavigation.getByRole('link', { name: '客服列表', exact: true }).click();
  await expect(merchantPage).toHaveURL(managementUrl + '/drafts');
  // Creating a new assistant has its own page; it is not buried below a list.
  await expect(merchantPage.locator('.assistant-create-form')).toHaveCount(0);
  await merchantPage
    .getByRole('main')
    .getByRole('link', { name: '新建客服', exact: true })
    .first()
    .click();
  await expect(merchantPage).toHaveURL(managementUrl + '/drafts/new');
  await expect(merchantPage.getByRole('button', { name: '创建客服草稿' })).toBeEnabled();
  await operatorPage.reload();
  await expect(operatorPage.getByRole('link', { name: managementUrl })).toHaveAttribute(
    'href',
    managementUrl,
  );
  const merchantSearch = operatorPage.getByRole('search');
  await merchantSearch.getByLabel('按名称或完整商家 ID 查找').fill(merchantName);
  await merchantSearch.getByRole('button', { name: '查找商家' }).click();
  await expect(operatorPage.getByRole('heading', { name: '查找商家' })).toBeVisible();
  await expect(operatorPage.getByRole('link', { name: managementUrl })).toHaveAttribute(
    'href',
    managementUrl,
  );
  await merchantSearch
    .getByLabel('按名称或完整商家 ID 查找')
    .fill(managementUrl.split('/').at(-1)!);
  await merchantSearch.getByRole('button', { name: '查找商家' }).click();
  await expect(operatorPage.getByRole('link', { name: managementUrl })).toHaveAttribute(
    'href',
    managementUrl,
  );
  await operatorPage.getByRole('link', { name: '查看最近商家' }).click();

  await merchantPage.getByLabel('客服名称').fill(assistantName);
  await merchantPage.getByLabel('行业资料引导（可选）').selectOption({
    label: '本地生活服务 · v1',
  });
  await openMerchantDetails(merchantPage, '本地生活服务：查看资料准备提示');
  await expect(merchantPage.getByText(referenceNotes)).toBeVisible();
  await expect(merchantPage.getByLabel('细分行业')).toHaveValue('本地生活服务');
  await merchantPage.getByLabel('细分行业').fill('家电清洗');
  await merchantPage.getByLabel('业务范围').fill('提供家用空调清洗咨询');
  await merchantPage.getByLabel('商品或服务资料').fill('提供上门空调清洗服务');
  await openMerchantDetails(merchantPage, '交易规则');
  await merchantPage.getByLabel('价格与条件').fill('价格需联系商家确认');
  await merchantPage.getByLabel('优惠与售卖策略').fill('目前无已确认优惠');
  await openMerchantDetails(merchantPage, '回复设置');
  await merchantPage.getByLabel('欢迎语').fill('您好，我是 AI 客服。');
  await merchantPage.getByLabel('资料不足时的回复').fill('资料不足，请联系商家核实。');
  await merchantPage
    .getByLabel('人工联系说明（可选）')
    .fill('工作日9:00至18:00，请通过测试店铺订单页联系人工。');
  await merchantPage.getByRole('button', { name: '创建客服草稿' }).click();
  await expect(merchantPage).toHaveURL(
    new RegExp(`^${managementUrl}/knowledge/[0-9a-f]{32}$`, 'u'),
  );
  const assistantId = new URL(merchantPage.url()).pathname.split('/').at(-1)!;
  const assistantUrl = `${managementUrl}/drafts/${assistantId}`;
  await expectMerchantStep(merchantPage, '知识补充');
  await expect(merchantPage.getByText(`当前客服：${assistantName}`, { exact: true })).toBeVisible();
  await operatorPage.reload();
  const industryTemplate = operatorPage.locator('.ops-template-list li').filter({
    hasText: industryCode,
  });
  await industryTemplate.getByText('停用此行业模板', { exact: true }).click();
  await industryTemplate.getByRole('button', { name: '确认停用此行业模板' }).click();
  await expect(industryTemplate).toContainText('已停用');
  await operatorPage.reload();
  await expect(industryTemplate).toContainText('已停用');
  await expect(industryTemplate.getByRole('button', { name: '确认停用此行业模板' })).toHaveCount(0);
  await merchantPage.goto(`${managementUrl}/drafts/new`);
  await expect(merchantPage.getByRole('option', { name: '本地生活服务 · v1' })).toHaveCount(0);
  await merchantPage.goto(assistantUrl);
  await expectMerchantStep(merchantPage, '基础资料');
  await merchantPage
    .getByRole('navigation', { name: '客服发布步骤' })
    .getByRole('link', { name: /^知识补充/u })
    .click();
  await expect(merchantPage).toHaveURL(managementUrl + '/knowledge/' + assistantId);
  await expectMerchantStep(merchantPage, '知识补充');
  await expect(merchantPage.locator('.assistant-edit-form')).toHaveCount(0);
  await expect(merchantPage.locator('.assistant-preview-form')).toHaveCount(0);
  await expect(merchantPage.locator('.assistant-confirm-form')).toHaveCount(0);
  await expect(merchantPage.getByText(referenceNotes)).toHaveCount(0);
  // Actual upload/extraction, consented organization and an explicit review.
  const materialPanel = merchantPage.getByRole('region', { name: '基础材料管理' });
  const deletedMaterialName = '待删除的旧材料A.txt';
  const retainedMaterialName = '空调清洗基础资料B.txt';
  await materialPanel.getByLabel('选择基础材料').setInputFiles([
    {
      name: deletedMaterialName,
      mimeType: 'text/plain',
      buffer: Buffer.from('合成旧材料A：本条仅用于验证删除，不应进入最终知识。', 'utf8'),
    },
    {
      name: retainedMaterialName,
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '提供上门空调清洗咨询，预约需提前1天；不提供安装服务。价格和优惠需商家确认。',
        'utf8',
      ),
    },
  ]);
  await materialPanel.getByRole('button', { name: '上传并提取文字', exact: true }).click();
  await expect(materialPanel.getByRole('status')).toContainText('已保存 2 份', { timeout: 60000 });
  const materialA = materialPanel.getByRole('checkbox', {
    name: new RegExp(deletedMaterialName, 'u'),
  });
  const materialB = materialPanel.getByRole('checkbox', {
    name: new RegExp(retainedMaterialName, 'u'),
  });
  await expect(materialA).toBeChecked();
  await expect(materialB).toBeChecked();
  await materialPanel.getByRole('button', { name: '直接使用提取文字', exact: true }).click();
  await expect(materialPanel.getByLabel('知识整理稿', { exact: true })).toHaveValue(/合成旧材料A/u);
  await materialPanel.getByRole('checkbox', { name: /我已核对整理稿/u }).check();
  const deleteButton = materialPanel.getByRole('button', {
    name: `删除材料：${deletedMaterialName}`,
    exact: true,
  });
  await deleteButton.click();
  const deleteDialog = materialPanel.getByRole('alertdialog', {
    name: `删除材料：${deletedMaterialName}`,
    exact: true,
  });
  await expect(deleteDialog).toContainText('不会自动修改已保存草稿、已发布客服或消费者链接');
  await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(materialA).toBeChecked();
  await deleteButton.click();
  const deletionResponse = merchantPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/knowledge/${assistantId}/materials/delete`),
  );
  await deleteDialog.getByRole('button', { name: '确认删除材料', exact: true }).click();
  const deletion = await deletionResponse;
  expect(deletion.status()).toBe(200);
  const deletedSource = (await deletion.json()) as { deleted: boolean; sourceId: string };
  expect(deletedSource.deleted).toBe(true);
  expect(deletedSource.sourceId).toMatch(/^[0-9a-f]{32}$/u);
  await expect(materialA).toHaveCount(0);
  await expect(materialB).toBeChecked();
  await expect(materialPanel.getByLabel('知识整理稿', { exact: true })).toHaveValue('');
  await expect(materialPanel.getByRole('checkbox', { name: /我已核对整理稿/u })).not.toBeChecked();
  await expect(
    materialPanel.getByRole('checkbox', { name: /我同意将所选材料的文字/u }),
  ).not.toBeChecked();
  await materialPanel.getByRole('button', { name: '直接使用提取文字', exact: true }).click();
  await expect(materialPanel.getByLabel('知识整理稿', { exact: true })).not.toHaveValue(
    /合成旧材料A/u,
  );
  const unsavedSummary = await materialPanel.getByLabel('知识整理稿', { exact: true }).inputValue();
  const leaveDialog = merchantPage.waitForEvent('dialog');
  const cancelledNavigation = merchantPage
    .getByRole('link', { name: '下一步：效果试聊', exact: true })
    .click();
  cancelledNavigation.catch(() => undefined);
  const leavePrompt = await leaveDialog;
  expect(leavePrompt.type()).toBe('confirm');
  expect(leavePrompt.message()).toContain('未保存的资料');
  await leavePrompt.dismiss();
  await cancelledNavigation;
  await expect(merchantPage).toHaveURL(managementUrl + '/knowledge/' + assistantId);
  await expect(materialPanel.getByLabel('知识整理稿', { exact: true })).toHaveValue(unsavedSummary);
  // This reload deliberately discards only the unsaved synthetic summary.
  const reloadDialog = merchantPage.waitForEvent('dialog');
  const discardSummaryReload = merchantPage.reload();
  discardSummaryReload.catch(() => undefined);
  const reloadPrompt = await reloadDialog;
  expect(reloadPrompt.type()).toBe('beforeunload');
  await reloadPrompt.accept();
  await discardSummaryReload;
  await expect(materialA).toHaveCount(0);
  await expect(materialB).toBeVisible();
  await materialB.check();
  await expect(
    materialPanel.getByRole('button', { name: 'AI 整理所选材料', exact: true }),
  ).toBeDisabled();
  await materialPanel.getByRole('checkbox', { name: /我同意将所选材料的文字/u }).check();
  const organizationRequest = merchantPage.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname.endsWith(`/knowledge/${assistantId}/materials/organize`),
  );
  await materialPanel.getByRole('button', { name: 'AI 整理所选材料', exact: true }).click();
  const organization = (await organizationRequest).postDataJSON() as { sourceIds: string[] };
  expect(organization.sourceIds).toHaveLength(1);
  expect(organization.sourceIds).not.toContain(deletedSource.sourceId);
  await expect(materialPanel.getByLabel('知识整理稿', { exact: true })).toHaveValue(
    /预约需提前1天/u,
    { timeout: 30000 },
  );
  await mkdir('artifacts/ops-enhancement', { recursive: true });
  await materialPanel.screenshot({
    path: `artifacts/ops-enhancement/materials-desktop-${pathMode ?? 'root'}.png`,
  });
  const materialViewport = merchantPage.viewportSize();
  await merchantPage.setViewportSize({ width: 390, height: 844 });
  expect(
    await merchantPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await materialPanel.screenshot({
    path: `artifacts/ops-enhancement/materials-mobile-${pathMode ?? 'root'}.png`,
  });
  await merchantPage.setViewportSize(materialViewport ?? { width: 1280, height: 720 });
  await materialPanel.getByRole('checkbox', { name: /我已核对整理稿/u }).check();
  await materialPanel.getByRole('button', { name: '保存整理稿到客服草稿', exact: true }).click();
  await expect(materialPanel.getByRole('status')).toContainText('知识已保存到草稿');
  await openMerchantDetails(merchantPage, '查看已保存的商品与服务资料');
  await expect(merchantPage.locator('.workflow-saved-text')).toContainText('预约需提前1天');
  await expect(
    merchantPage.getByRole('button', { name: '确认当前草稿资料', exact: true }),
  ).toHaveCount(0);
  await merchantPage.getByRole('link', { name: '下一步：效果试聊', exact: true }).click();
  await expect(merchantPage).toHaveURL(managementUrl + '/preview/' + assistantId);
  await expectMerchantStep(merchantPage, '效果试聊');
  await expect(merchantPage.locator('.assistant-edit-form')).toHaveCount(0);
  await expect(merchantPage.getByRole('region', { name: '基础材料管理' })).toHaveCount(0);
  await expect(merchantPage.locator('.assistant-confirm-form')).toHaveCount(0);
  await expect(merchantPage.getByRole('img', { name: '扫码打开消费者 AI 客服' })).toHaveCount(0);
  await expect(merchantPage.locator('a[href^="http://127.0.0.1:3001/a/"]')).toHaveCount(0);
  await merchantPage.getByLabel('试聊问题').fill('你们提供什么服务？');
  await merchantPage.getByRole('button', { name: '发送测试问题' }).click();
  const previewAnswer = merchantPage.locator('.assistant-preview-answer');
  await expect(previewAnswer).toContainText(
    '我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。',
    { timeout: 60_000 },
  );
  await expect(merchantPage.locator('a[href^="http://127.0.0.1:3001/a/"]')).toHaveCount(0);
  await expect(merchantPage.getByRole('img', { name: '扫码打开消费者 AI 客服' })).toHaveCount(0);
  await merchantPage.getByRole('link', { name: '下一步：发布分享', exact: true }).click();
  await expect(merchantPage).toHaveURL(managementUrl + '/publish/' + assistantId);
  await expectMerchantStep(merchantPage, '发布分享');
  await expect(merchantPage.locator('.assistant-preview-form')).toHaveCount(0);
  await expect(merchantPage.locator('.assistant-edit-form')).toHaveCount(0);
  await expect(
    merchantPage.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }),
  ).toBeEnabled();
  await merchantPage.getByLabel(/我已核对以上资料，并确认向消费者公开发布当前修订/u).check();
  await merchantPage.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }).click();
  const publicLink = merchantPage.locator('a[href^="http://127.0.0.1:3001/a/"]').first();
  await expect(publicLink).toBeVisible();
  const publicUrl = await publicLink.getAttribute('href');
  expect(publicUrl).toMatch(/^http:\/\/127\.0\.0\.1:3001\/a\/[a-z0-9-]+$/u);
  await expect(
    merchantPage.getByRole('heading', { name: '固定消费者链接', exact: true }),
  ).toBeVisible();
  await expect(merchantPage.locator('#consumer-link')).toBeInViewport();
  await merchantPage.reload();
  await expect(publicLink).toHaveAttribute('href', publicUrl!);
  const shareQr = merchantPage.getByRole('img', { name: '扫码打开消费者 AI 客服' }).first();
  await expect(shareQr).toBeVisible();
  await expect(shareQr).toHaveAttribute('src', /^data:image\/png;base64,/u);
  await expect(merchantPage.getByRole('link', { name: '下载二维码' }).first()).toHaveAttribute(
    'download',
    /^ai-customer-service-[a-z0-9-]+\.png$/u,
  );
  await operatorPage.reload();
  const assistantState = operatorPage
    .locator('.ops-assistant-list li')
    .filter({ hasText: assistantName });
  await expect(assistantState).toContainText('已发布');

  const consumerPage = sharedContext ? await sharedContext.newPage() : await browser.newPage();
  await consumerPage.goto(publicUrl!);
  await expect(consumerPage.getByRole('heading', { name: assistantName })).toBeVisible();
  await consumerPage.getByText('联系商家 / 人工服务', { exact: true }).click();
  await expect(
    consumerPage.getByText('工作日9:00至18:00，请通过测试店铺订单页联系人工。', { exact: true }),
  ).toBeVisible();
  await expect(consumerPage.getByText(/此处不实时转接/u)).toBeVisible();
  await consumerPage.getByRole('textbox', { name: '输入想咨询的问题' }).fill('你们提供什么服务？');
  const firstSessionResponse = consumerPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/v1\/public\/assistants\/[a-z0-9-]+\/sessions$/u.test(
        new URL(response.url()).pathname,
      ),
  );
  await consumerPage.getByRole('button', { name: '发送消息' }).click();
  const firstSessionPayload = (await (await firstSessionResponse).json()) as {
    data: { releaseRef: string; sessionHandle: string };
  };
  const firstReleaseRef = firstSessionPayload.data.releaseRef;
  const answer = consumerPage
    .getByText('我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。')
    .first();
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(answer).toContainText('预约需提前1天；不提供安装服务。');
  const merchantId = new URL(managementUrl).pathname.slice(1);
  expect(merchantId).toMatch(/^[0-9a-f]{32}$/u);
  await merchantPage.goto(`${merchantOrigin}/${merchantId}/conversations`);
  await expect(merchantPage.getByRole('heading', { name: '咨询管理' })).toBeVisible();
  await merchantPage.locator('.merchant-conversation-list a').first().click();
  await expect(merchantPage.getByText('你们提供什么服务？')).toBeVisible();
  await expect(
    merchantPage.getByText('我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。'),
  ).toBeVisible();
  await merchantPage.getByRole('combobox', { name: '人工跟进状态' }).selectOption('in_progress');
  await merchantPage.getByRole('button', { name: '保存跟进状态' }).click();
  await expect(merchantPage.getByText('已保存；咨询原始消息未修改。')).toBeVisible();
  await merchantPage.reload();
  await expect(
    merchantPage.locator('.ui-status-badge').filter({ hasText: '处理中' }),
  ).toBeVisible();
  // This fake-model path proves persistence and merchant workflow only. Qwen quality
  // is evaluated separately using the synthetic retail scenario pack.
  const sourceConversationUrl = merchantPage.url();
  await merchantPage.getByRole('link', { name: '改进这条回答', exact: true }).first().click();
  await expect(merchantPage.getByLabel('消费者问题或测试问题')).toHaveValue('你们提供什么服务？');
  await merchantPage
    .getByLabel('商家期望答案（真实有效的事实和处理方式）')
    .fill('我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。');
  await merchantPage.getByRole('button', { name: '建立改进任务', exact: true }).click();
  await expect(merchantPage).toHaveURL(/\/improvements\/[0-9a-f]{32}\?assistant=[0-9a-f]{32}$/u);
  const improvementUrl = merchantPage.url();
  await expect(
    merchantPage.getByRole('heading', { name: '改进这条回答', exact: true }),
  ).toBeVisible();
  await merchantPage.getByLabel(/已核对真实事实和适用条件/u).check();
  await merchantPage.getByRole('button', { name: '应用修正到草稿 FAQ', exact: true }).click();
  await expect(merchantPage.getByText(/修正已写入草稿修订/u)).toBeVisible();
  await merchantPage.reload();
  await expect(merchantPage.locator('pre[aria-label="拟写入草稿的 FAQ"]')).toContainText(
    '你们提供什么服务？',
  );
  await merchantPage.getByLabel(/同意将当前草稿的业务资料和本条问题/u).check();
  await merchantPage.getByRole('button', { name: '发送问题并记录复测', exact: true }).click();
  await expect(
    merchantPage.getByRole('button', { name: '符合预期，判定通过', exact: true }),
  ).toBeEnabled({ timeout: 60_000 });
  await merchantPage.getByRole('button', { name: '符合预期，判定通过', exact: true }).click();
  await expect(merchantPage.getByText('商家已判定通过。', { exact: true })).toBeVisible();
  await merchantPage.getByRole('link', { name: '核对并确认知识资料', exact: true }).click();
  await expect(merchantPage).toHaveURL(`${managementUrl}/knowledge/${assistantId}`);
  await merchantPage.getByRole('link', { name: '下一步：效果试聊', exact: true }).click();
  await expectMerchantStep(merchantPage, '效果试聊');
  await merchantPage.getByRole('link', { name: '下一步：发布分享', exact: true }).click();
  await expectMerchantStep(merchantPage, '发布分享');
  await merchantPage.getByLabel(/我已核对以上资料，并确认向消费者公开发布当前修订/u).check();
  await merchantPage.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }).click();
  await expect(merchantPage.getByText(/第 2 版已发布/u)).toBeVisible();
  await expect(merchantPage.locator('#consumer-link')).toBeInViewport();
  for (const section of ['knowledge', 'preview', 'publish', 'drafts']) {
    await merchantPage.goto(`${managementUrl}/${section}/${assistantId}`);
    await expect(
      merchantPage.getByRole('heading', { name: '固定消费者链接', exact: true }),
    ).toBeVisible();
    await openMerchantDetails(merchantPage, '查看链接与二维码');
    await expect(publicLink).toHaveAttribute('href', publicUrl!);
    await merchantPage.reload();
    await openMerchantDetails(merchantPage, '查看链接与二维码');
    await expect(publicLink).toHaveAttribute('href', publicUrl!);
    await mkdir('artifacts/ops-enhancement/merchant-guided-workflow', { recursive: true });
    for (const [width, height, viewport] of [
      [1440, 1000, 'desktop'],
      [390, 844, 'mobile'],
    ] as const) {
      await merchantPage.setViewportSize({ width, height });
      expect(
        await merchantPage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      await merchantPage.screenshot({
        path: `artifacts/ops-enhancement/merchant-guided-workflow/${section}-${viewport}-${pathMode ?? 'root'}.png`,
        fullPage: true,
      });
    }
    await merchantPage.setViewportSize({ width: 1280, height: 720 });
  }
  await merchantPage.goto(improvementUrl);
  await expect(
    merchantPage.getByText('本条改进已关联当前线上版本。', { exact: false }),
  ).toBeVisible();
  await merchantPage.setViewportSize({ width: 390, height: 844 });
  expect(
    await merchantPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await mkdir('artifacts/improvement-r1', { recursive: true });
  await merchantPage.screenshot({
    path: 'artifacts/improvement-r1/merchant-mobile.png',
    fullPage: true,
  });
  await merchantPage.setViewportSize({ width: 1280, height: 720 });
  await merchantPage.screenshot({
    path: 'artifacts/improvement-r1/merchant-desktop.png',
    fullPage: true,
  });
  await merchantPage.goto(sourceConversationUrl);
  await expect(merchantPage.getByText('你们提供什么服务？', { exact: true })).toBeVisible();
  await merchantPage.getByRole('link', { name: '编辑对应客服的资料' }).click();
  await expectMerchantStep(merchantPage, '基础资料');
  const editRevision = merchantPage.locator('.assistant-edit-form input[name="draftRevision"]');
  const beforeManualEdit = Number(await editRevision.inputValue());
  expect(Number.isSafeInteger(beforeManualEdit) && beforeManualEdit > 0).toBe(true);
  // Open and close a local-only helper to prove hydration before editing saved
  // values; this does not send any data or consume a model call.
  await merchantPage.getByRole('button', { name: '帮我写商品或服务资料', exact: true }).click();
  await merchantPage.getByRole('button', { name: '关闭填写助手', exact: true }).click();
  await merchantPage
    .locator('.assistant-edit-form textarea[name="materialsSummary"]')
    .fill('提供上门空调清洗服务，也提供洗衣机清洁咨询');
  await merchantPage.getByRole('button', { name: '保存草稿修订' }).click();
  await expect(editRevision).toHaveValue(String(beforeManualEdit + 1));
  await merchantPage.reload();
  await expect(editRevision).toHaveValue(String(beforeManualEdit + 1));
  await expect(
    merchantPage.locator('.assistant-edit-form textarea[name="materialsSummary"]'),
  ).toHaveValue('提供上门空调清洗服务，也提供洗衣机清洁咨询');
  // This is the normal saved transition into supplemental knowledge, not a
  // jump to an unrelated menu or an unsaved navigation.
  await merchantPage.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(merchantPage).toHaveURL(`${managementUrl}/knowledge/${assistantId}`);
  const beforeConcurrentEdit = Number(
    (await merchantPage.getByText(/^草稿修订 \d+$/u).textContent())?.match(/\d+$/u)?.[0],
  );
  expect(beforeConcurrentEdit).toBe(beforeManualEdit + 2);
  await merchantPage.getByRole('link', { name: '下一步：效果试聊', exact: true }).click();
  await merchantPage.getByRole('link', { name: '下一步：发布分享', exact: true }).click();
  await expectMerchantStep(merchantPage, '发布分享');
  await merchantPage.getByLabel(/我已核对以上资料，并确认向消费者公开发布当前修订/u).check();
  const beforeStalePublication = await readPublishedRelease(merchantPage, publicUrl!);
  const concurrentDraftPage = await merchantPage.context().newPage();
  try {
    await concurrentDraftPage.goto(assistantUrl);
    await expectMerchantStep(concurrentDraftPage, '基础资料');
    await openMerchantDetails(concurrentDraftPage, '交易规则');
    await concurrentDraftPage
      .getByRole('button', { name: '帮我写价格与条件', exact: true })
      .click();
    await concurrentDraftPage.getByRole('button', { name: '关闭填写助手', exact: true }).click();
    await concurrentDraftPage
      .locator('.assistant-edit-form textarea[name="pricingSummary"]')
      .fill('具体价格按服务范围由商家核实确认。');
    await concurrentDraftPage.getByRole('button', { name: '保存草稿修订' }).click();
    await expect(
      concurrentDraftPage.locator('.assistant-edit-form input[name="draftRevision"]'),
    ).toHaveValue(String(beforeConcurrentEdit + 1));
    // A previously checked consent in another tab cannot publish a newer draft.
    await merchantPage.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }).click();
    await expect(merchantPage.locator('.assistant-confirm-form').getByRole('alert')).toContainText(
      '草稿或资料确认状态已变化',
    );
    expect(await readPublishedRelease(merchantPage, publicUrl!)).toEqual(beforeStalePublication);
  } finally {
    await concurrentDraftPage.close();
  }
  await merchantPage.reload();
  await expect(
    merchantPage.locator('.assistant-confirm-form input[name="draftRevision"]'),
  ).toHaveValue(String(beforeConcurrentEdit + 1));
  await expect(
    merchantPage.getByLabel(/我已核对以上资料，并确认向消费者公开发布当前修订/u),
  ).not.toBeChecked();
  await expect(publicLink).toHaveAttribute('href', publicUrl!);
  await merchantPage.reload();
  const preV3Release = await readPublishedRelease(merchantPage, publicUrl!);
  expect(preV3Release.status).toBe(200);
  expect(preV3Release.releaseRef).toMatch(/^[0-9a-f]{32}$/u);
  expect(preV3Release.releaseRef).not.toBe(firstReleaseRef);
  const thirdPublishUrl = merchantOrigin + '/' + merchantId + '/publish/' + assistantId;
  await expect(merchantPage).toHaveURL(thirdPublishUrl);
  await expectMerchantStep(merchantPage, '发布分享');
  const publishPath = new URL(thirdPublishUrl).pathname;
  let thirdPublicationPosts = 0,
    thirdActionStatus: number | null = null;
  let thirdPublishedReleaseRef: string | null = null;
  const countThirdPublication = (request: { method(): string; url(): string }) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === publishPath)
      thirdPublicationPosts += 1;
  };
  merchantPage.on('request', countThirdPublication);
  try {
    const publicationResponse = merchantPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === publishPath,
    );
    publicationResponse.catch(() => undefined);
    await merchantPage.getByLabel(/我已核对以上资料，并确认向消费者公开发布当前修订/u).check();
    await merchantPage.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }).click();
    thirdActionStatus = (await publicationResponse).status();
    expect(thirdActionStatus).toBe(200);
    await expect(merchantPage.getByText(/第 3 版已发布/u)).toBeVisible();
    await expect
      .poll(
        async () => {
          const current = await readPublishedRelease(merchantPage, publicUrl!);
          thirdPublishedReleaseRef = current.releaseRef;
          return (
            current.status === 200 &&
            current.releaseRef !== null &&
            current.releaseRef !== preV3Release.releaseRef
          );
        },
        { timeout: 30_000, message: 'The third publication must advance beyond version two' },
      )
      .toBe(true);
    expect(thirdPublicationPosts).toBe(1);
    await expect(publicLink).toHaveAttribute('href', publicUrl!);
  } catch (error) {
    const form = merchantPage.locator('.assistant-confirm-form');
    const alerts = await form
      .getByRole('alert')
      .allTextContents()
      .catch(() => []);
    const rawRevision = await form
      .locator('input[name="draftRevision"]')
      .inputValue()
      .catch(() => '');
    const current = await readPublishedRelease(merchantPage, publicUrl!).catch(() => null);
    process.stdout.write(
      JSON.stringify({
        code: 'E2E_THIRD_PUBLICATION_UNVERIFIED',
        routeIsExpected: merchantPage.url() === thirdPublishUrl,
        actionStatus: thirdActionStatus,
        publicationPosts: thirdPublicationPosts,
        requestedDraftRevision: /^[1-9][0-9]{0,9}$/u.test(rawRevision) ? Number(rawRevision) : null,
        preV3ReleaseRef: preV3Release.releaseRef,
        currentPublicStatus: current?.status ?? null,
        currentPublicReleaseRef: current?.releaseRef ?? null,
        alerts: alerts.slice(0, 3).map(safePublicationAlert),
        credentialsPrinted: false,
        automaticWriteRetry: false,
      }) + '\n',
    );
    throw error;
  } finally {
    merchantPage.off('request', countThirdPublication);
  }
  await consumerPage.reload();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  const publicSlug = new URL(publicUrl!).pathname.split('/')[2]!;
  const latestReleaseRef = await consumerPage.evaluate(async (slug) => {
    const response = await fetch(`/api/v1/public/assistants/${slug}`);
    const envelope = (await response.json()) as { data: { releaseRef: string } };
    return envelope.data.releaseRef;
  }, publicSlug);
  expect(latestReleaseRef).not.toBe(firstReleaseRef);
  expect(latestReleaseRef).not.toBe(preV3Release.releaseRef);
  expect(latestReleaseRef).toBe(thirdPublishedReleaseRef);
  const oldHistoryRelease = await consumerPage.evaluate(async (sessionHandle) => {
    const response = await fetch(`/api/v1/public/sessions/${sessionHandle}/history`);
    if (response.status !== 200) throw new Error('Old synthetic history is unavailable');
    const envelope = (await response.json()) as { data: { releaseRef: string } };
    return envelope.data.releaseRef;
  }, firstSessionPayload.data.sessionHandle);
  expect(oldHistoryRelease).toBe(firstReleaseRef);
  const oldAssistantReplyCount = await consumerPage
    .locator('.message-row--assistant .message-bubble p')
    .count();
  await consumerPage
    .getByRole('textbox', { name: '输入想咨询的问题' })
    .fill('现在可以提供哪些清洁咨询？');
  await consumerPage.getByRole('button', { name: '发送消息' }).click();
  await expect(consumerPage.locator('.message-row--assistant .message-bubble p')).toHaveCount(
    oldAssistantReplyCount + 1,
    { timeout: 60_000 },
  );
  const oldSessionAnswer = consumerPage.locator('.message-row--assistant .message-bubble p').last();
  await expect(oldSessionAnswer).toContainText('预约需提前1天；不提供安装服务。', {
    timeout: 60_000,
  });
  await expect(oldSessionAnswer).not.toContainText('洗衣机清洁');
  consumerPage.once('dialog', (dialog) => void dialog.accept());
  await consumerPage.getByRole('button', { name: '新建咨询' }).click();
  await expect(answer).toHaveCount(0);
  await consumerPage
    .getByRole('textbox', { name: '输入想咨询的问题' })
    .fill('洗衣机清洁可以咨询吗？');
  const secondSessionResponse = consumerPage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/v1\/public\/assistants\/[a-z0-9-]+\/sessions$/u.test(
        new URL(response.url()).pathname,
      ),
  );
  await consumerPage.getByRole('button', { name: '发送消息' }).click();
  const secondSessionPayload = (await (await secondSessionResponse).json()) as {
    data: { releaseRef: string };
  };
  expect(secondSessionPayload.data.releaseRef).toBe(latestReleaseRef);
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await expect(
    consumerPage.locator('.message-row--assistant .message-bubble p').last(),
  ).toContainText('也提供洗衣机清洁咨询');

  await operatorPage.reload();
  const merchantRow = operatorPage
    .locator('.ops-merchant-list li')
    .filter({ hasText: merchantName });
  await merchantRow.getByText('暂停商家', { exact: true }).click();
  await merchantRow.getByLabel('操作原因（写入审计）').fill('浏览器验收：暂停公开客服服务');
  await merchantRow.getByLabel('我已核对商家编号和操作影响').check();
  await merchantRow.getByRole('button', { name: '确认暂停商家' }).click();
  await expect(merchantRow).toContainText('已暂停');
  await operatorPage.reload();
  await expect(merchantRow).toContainText('已暂停');
  const pausedStatus = await consumerPage.evaluate(
    async (slug) => (await fetch(`/api/v1/public/assistants/${slug}`)).status,
    publicSlug,
  );
  expect(pausedStatus).toBe(404);

  await merchantRow.getByText('恢复商家', { exact: true }).click();
  await merchantRow.getByLabel('操作原因（写入审计）').fill('浏览器验收：原因已解除并恢复服务');
  await merchantRow.getByLabel('我已核对商家编号和操作影响').check();
  await merchantRow.getByRole('button', { name: '确认恢复商家' }).click();
  await expect(merchantRow).toContainText('运行中');
  await operatorPage.reload();
  await expect(merchantRow).toContainText('运行中');
  const resumedStatus = await consumerPage.evaluate(
    async (slug) => (await fetch(`/api/v1/public/assistants/${slug}`)).status,
    publicSlug,
  );
  expect(resumedStatus).toBe(200);

  // The same genuine consumer records must appear once in operator reports.
  // This does not send any additional messages or model requests.
  process.stdout.write('[ops-e2e] verifying merchant usage and detail controls\n');
  operatorPage.setDefaultTimeout(30_000);
  const opsNavigation = operatorPage.getByRole('navigation', { name: '运营后台主导航' });
  const merchantMenu = opsNavigation.getByRole('button', { name: '商家运营', exact: true });
  // A two-level menu must be operable by keyboard, and collapsed children must
  // not remain clickable or focusable. Keep the browser's actual button state.
  if ((await merchantMenu.getAttribute('aria-expanded')) === 'true') await merchantMenu.click();
  await expect(opsNavigation.getByRole('link', { name: '商家管理', exact: true })).toBeHidden();
  await merchantMenu.focus();
  await merchantMenu.press('Enter');
  await expect(merchantMenu).toHaveAttribute('aria-expanded', 'true');
  await opsNavigation.getByRole('link', { name: '商家管理', exact: true }).click();
  await expect(operatorPage).toHaveURL(`${operatorBase}/merchants`);
  await expect(merchantMenu).toHaveAttribute('aria-expanded', 'true');
  await expect(opsNavigation.getByRole('link', { name: '商家管理', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await operatorPage.getByLabel('商家名称或完整 ID', { exact: true }).fill(merchantName);
  await operatorPage.getByRole('button', { name: '应用筛选', exact: true }).click();
  const usageRow = operatorPage
    .locator('.ops-data-table tbody tr')
    .filter({ hasText: merchantName });
  await expect(usageRow).toHaveCount(1);
  await usageRow.getByRole('link', { name: '查看详情', exact: true }).click();
  await expect(operatorPage).toHaveURL(new RegExp(`/${merchantId}\\?`, 'u'));
  await expect(
    operatorPage.getByRole('heading', { name: merchantName, exact: true }),
  ).toBeVisible();
  await expect(
    operatorPage.locator('.ops-stat-card').filter({ hasText: '消费者问句' }).locator('strong'),
  ).toHaveText('3');
  await expect(
    operatorPage.locator('.ops-stat-card').filter({ hasText: '新建消费者会话' }).locator('strong'),
  ).toHaveText('2');
  await expect(operatorPage.getByRole('table').filter({ hasText: assistantName })).toBeVisible();

  // The detail management controls retain the existing confirmation/audit and
  // public-service behavior, not merely a client-only status toggle.
  const statusPanel = operatorPage.getByRole('region', { name: '商家状态管理' });
  await statusPanel.getByText('暂停此商家', { exact: true }).click();
  await statusPanel.getByLabel('操作原因（写入审计）').fill('运营增强合成验收：详情页暂停');
  await statusPanel.getByLabel('我已核对商家编号和操作影响').check();
  await statusPanel.getByRole('button', { name: '确认暂停商家' }).click();
  await expect(statusPanel.getByText('恢复此商家', { exact: true })).toBeVisible();
  expect(
    await consumerPage.evaluate(
      async (slug) => (await fetch(`/api/v1/public/assistants/${slug}`)).status,
      publicSlug,
    ),
  ).toBe(404);
  await expect(
    operatorPage.locator('.ops-stat-card').filter({ hasText: '消费者问句' }).locator('strong'),
  ).toHaveText('3');
  await statusPanel.getByText('恢复此商家', { exact: true }).click();
  await statusPanel.getByLabel('操作原因（写入审计）').fill('运营增强合成验收：详情页恢复');
  await statusPanel.getByLabel('我已核对商家编号和操作影响').check();
  await statusPanel.getByRole('button', { name: '确认恢复商家' }).click();
  await expect(statusPanel.getByText('暂停此商家', { exact: true })).toBeVisible();
  expect(
    await consumerPage.evaluate(
      async (slug) => (await fetch(`/api/v1/public/assistants/${slug}`)).status,
      publicSlug,
    ),
  ).toBe(200);

  await operatorPage.getByRole('link', { name: '查看此商家报表与导出', exact: true }).click();
  const reportTypes = operatorPage.getByRole('navigation', { name: '报表类型' });
  // A preset must reset an edited-but-unsubmitted date field as well as the
  // report query. Visible filters and exported data must describe the same range.
  await operatorPage.getByLabel('开始日期', { exact: true }).fill('2000-01-01');
  await operatorPage.getByRole('link', { name: '今天', exact: true }).click();
  await expect(operatorPage).toHaveURL(/(?:\?|&)days=1(?:&|$)/u);
  const todayValue = await operatorPage.getByLabel('开始日期', { exact: true }).getAttribute('max');
  if (!todayValue || !/^\d{4}-\d{2}-\d{2}$/u.test(todayValue))
    throw new Error('Expected the server-defined Beijing day');
  await expect(operatorPage.getByLabel('开始日期', { exact: true })).toHaveValue(todayValue);
  await expect(operatorPage.getByLabel('结束日期', { exact: true })).toHaveValue(todayValue);
  await operatorPage.getByRole('link', { name: '近 7 天', exact: true }).click();
  await expect(operatorPage).toHaveURL(/(?:\?|&)days=7(?:&|$)/u);
  const sevenDayStart = new Date(Date.parse(`${todayValue}T00:00:00.000Z`) - 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await expect(operatorPage.getByLabel('开始日期', { exact: true })).toHaveValue(sevenDayStart);
  await expect(operatorPage.getByLabel('结束日期', { exact: true })).toHaveValue(todayValue);
  for (const [label, kind, expectedColumn] of [
    ['每日使用', 'daily', '消费者问句'],
    ['商家使用', 'merchants', '商家名称'],
    ['客服使用', 'assistants', '客服名称'],
    ['改进与复测', 'quality', '复测运行次数'],
    ['异常分布', 'errors', '当前失败记录数'],
  ] as const) {
    await reportTypes.getByRole('link', { name: label, exact: true }).click();
    await expect(operatorPage.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(
      opsNavigation.getByRole('button', { name: '数据报表', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(opsNavigation.getByRole('link', { name: label, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const downloadPromise = operatorPage.waitForEvent('download', { timeout: 30_000 });
    await operatorPage.getByRole('button', { name: '导出本报表 CSV', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^h5cs-${kind}-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}\\.csv$`, 'u'),
    );
    const path = await download.path();
    if (!path) throw new Error('Expected an actual downloaded CSV');
    const csv = await readFile(path, 'utf8');
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain(expectedColumn);
    expect(csv).not.toContain(merchantPhone);
    expect(csv).not.toContain(merchantPassword);
    expect(csv).not.toContain('你们提供什么服务？');
    expect(csv).not.toContain('洗衣机清洁可以咨询吗？');
    if (kind === 'daily') expect(csv.split('\r\n').filter(Boolean)).toHaveLength(8);
    await download.delete();
    process.stdout.write(`[ops-e2e] ${kind} CSV verified\n`);
  }
  await operatorPage.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/merchants', '/reports']) {
    await operatorPage.goto(operatorBase + path);
    await expect(operatorPage.locator('.ops-analytics')).toBeVisible();
    expect(
      await operatorPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
  await mkdir('artifacts/ops-enhancement', { recursive: true });
  await operatorPage.screenshot({
    path: `artifacts/ops-enhancement/reports-mobile-${process.env['H5CS_E2E_PATH_MODE'] ?? 'root'}.png`,
    fullPage: true,
  });
  const mobileToggle = operatorPage.getByRole('button', { name: '展开菜单', exact: true });
  await expect(opsNavigation).toBeHidden();
  await mobileToggle.click();
  await expect(opsNavigation).toBeVisible();
  await expect(
    opsNavigation.getByRole('button', { name: '数据报表', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await operatorPage.screenshot({
    path: `artifacts/ops-enhancement/menu-mobile-${process.env['H5CS_E2E_PATH_MODE'] ?? 'root'}.png`,
    fullPage: true,
  });
  await operatorPage.keyboard.press('Escape');
  await expect(opsNavigation).toBeHidden();
  await expect(mobileToggle).toBeFocused();
  await mobileToggle.click();
  await opsNavigation.getByRole('link', { name: '商家使用', exact: true }).click();
  await expect(operatorPage).toHaveURL(`${operatorBase}/reports?report=merchants`);
  await expect(opsNavigation).toBeHidden();
  await mobileToggle.click();
  await expect(opsNavigation.getByRole('link', { name: '商家使用', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    opsNavigation.getByRole('button', { name: '数据报表', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await operatorPage.getByRole('button', { name: '收起菜单', exact: true }).click();
  await operatorPage.setViewportSize({ width: 1440, height: 1000 });
  await expect(opsNavigation).toBeVisible();
  const sidebarBox = await operatorPage
    .getByRole('complementary', { name: '平台运营导航' })
    .boundingBox();
  const contentBox = await operatorPage.getByRole('main').boundingBox();
  expect(sidebarBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(sidebarBox!.x).toBe(0);
  expect(sidebarBox!.width).toBeGreaterThan(200);
  expect(contentBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
  await operatorPage.screenshot({
    path: `artifacts/ops-enhancement/reports-desktop-${process.env['H5CS_E2E_PATH_MODE'] ?? 'root'}.png`,
    fullPage: true,
  });
  // Native section links must retain /ops when deployed under the same domain.
  await opsNavigation.getByRole('button', { name: '运行管理', exact: true }).click();
  await expect(opsNavigation.getByRole('link', { name: '审计记录', exact: true })).toHaveAttribute(
    'href',
    `${prefixed ? '/ops' : ''}/#audit-log`,
  );
  await opsNavigation.getByRole('link', { name: '审计记录', exact: true }).click();
  // Next canonicalizes the prefixed homepage /ops/ to /ops; root remains /.
  await expect(operatorPage).toHaveURL(`${operatorBase}${prefixed ? '' : '/'}#audit-log`);
  await expect(
    operatorPage.getByRole('heading', { name: '最近审计记录', exact: true }),
  ).toBeVisible();
  await expect(
    opsNavigation.getByRole('button', { name: '运行管理', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(opsNavigation.getByRole('link', { name: '审计记录', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );

  // A genuine merchant session is not an operator session, even on one domain.
  const merchantOnlyContext = await browser.newContext();
  try {
    const onlyMerchantCookies = (await merchantPage.context().cookies()).filter((cookie) =>
      ['h5cs_session', 'h5cs_csrf'].includes(cookie.name),
    );
    expect(onlyMerchantCookies.some((cookie) => cookie.name === 'h5cs_session')).toBe(true);
    await merchantOnlyContext.addCookies(onlyMerchantCookies);
    const merchantOnlyPage = await merchantOnlyContext.newPage();
    await merchantOnlyPage.goto(managementUrl);
    await expect(merchantOnlyPage).toHaveURL(managementUrl);
    await merchantOnlyPage.goto(operatorBase + '/merchants');
    await expect(merchantOnlyPage).toHaveURL(operatorBase + '/login');
    expect((await merchantOnlyContext.request.get(operatorBase + '/reports/export')).status()).toBe(
      401,
    );
  } finally {
    await merchantOnlyContext.close();
  }
  // Administrative reset: read an actual login account, re-authenticate the
  // operator, invalidate the old merchant session, then log in with new secret.
  await operatorPage.goto(`${operatorBase}/merchants/${merchantId}`);
  const accounts = operatorPage.getByRole('region', { name: '商家账号管理' });
  const managedAccount = (await accounts.locator('code').first().textContent())!;
  expect(managedAccount).toMatch(/^m_[0-9a-f]{32}$/u);
  await accounts.getByText('重置此账号密码', { exact: true }).click();
  // Capture only the synthetic account panel before any password is entered.
  await accounts.screenshot({
    path: `artifacts/ops-enhancement/accounts-desktop-${pathMode ?? 'root'}.png`,
  });
  const replacementPassword = randomBytes(24).toString('base64url');
  await accounts.getByLabel('新密码', { exact: true }).fill(replacementPassword);
  await accounts.getByLabel('确认新密码', { exact: true }).fill(replacementPassword);
  await accounts
    .getByLabel('重置原因（写入审计）', { exact: true })
    .selectOption({ label: '忘记密码' });
  await accounts.getByLabel('当前运营账号密码', { exact: true }).fill(operatorPassword);
  await accounts.getByRole('checkbox', { name: /我已核对账号与全部关联商家/u }).check();
  await accounts.getByRole('button', { name: '确认重置商家密码', exact: true }).click();
  await expect(accounts.getByRole('status')).toContainText('密码已重置');
  await merchantPage.goto(managementUrl);
  await expect(merchantPage).toHaveURL(/\/account\/login\?/u);
  await merchantPage.getByLabel('账号或手机号', { exact: true }).fill(merchantPhone);
  await merchantPage.getByLabel('密码', { exact: true }).fill(merchantPassword);
  await merchantPage.getByRole('button', { name: '登录商家后台', exact: true }).click();
  await expect(merchantPage.locator('.merchant-account-form').getByRole('alert')).toContainText(
    '密码不正确',
  );
  await merchantPage.getByLabel('账号或手机号', { exact: true }).fill(managedAccount);
  await merchantPage.getByLabel('密码', { exact: true }).fill(replacementPassword);
  await merchantPage.getByRole('button', { name: '登录商家后台', exact: true }).click();
  await expect(merchantPage).toHaveURL(managementUrl);
  expect(
    await consumerPage.evaluate(
      async (slug) => (await fetch(`/api/v1/public/assistants/${slug}`)).status,
      publicSlug,
    ),
  ).toBe(200);
  process.stdout.write('[ops-e2e] responsive layout and merchant/operator separation verified\n');
});
