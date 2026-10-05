import { randomBytes, randomInt } from 'node:crypto';

import { expect, test } from '@playwright/test';

test('operator provisions a merchant, merchant previews and publishes, consumer receives an AI reply', async ({
  browser,
}) => {
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
  await operatorPage.getByRole('button', { name: '登录运营后台' }).click();
  try {
    await expect(operatorPage).toHaveURL(
      sameOrigin
        ? /^http:\/\/127\.0\.0\.1:3001\/ops\/?$/u
        : prefixed
          ? /^http:\/\/127\.0\.0\.1:3002\/ops\/?$/u
          : 'http://127.0.0.1:3002/',
      { timeout: 10_000 },
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
  await expect(merchantPage).toHaveURL(/\/workspace\/[0-9a-f]{32}$/u);
  const managementUrl = merchantPage.url();
  await expect(
    merchantPage.getByRole('link', { name: '进入商家工作台', exact: true }),
  ).toHaveAttribute('href', new URL(managementUrl).pathname);
  await expect(merchantPage.getByRole('link', { name: 'HTTPS 安全绑定' })).toHaveCount(0);
  const merchantNavigation = merchantPage.getByRole('navigation', { name: '商家后台主导航' });
  for (const name of ['客服草稿', '知识库', '测试与发布']) {
    await merchantNavigation.getByRole('link', { name, exact: true }).click();
    await expect(merchantPage).toHaveURL(`${managementUrl}#assistants`);
    await expect(merchantPage.getByRole('heading', { name: '已创建的客服' })).toBeVisible();
  }
  await merchantNavigation.getByRole('link', { name: '工作台', exact: true }).click();
  await expect(merchantPage).toHaveURL(managementUrl);
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
  await expect(merchantPage.getByText(referenceNotes)).toBeVisible();
  await expect(merchantPage.getByLabel('细分行业')).toHaveValue('本地生活服务');
  await merchantPage.getByLabel('细分行业').fill('家电清洗');
  await merchantPage.getByLabel('业务范围').fill('提供家用空调清洗咨询');
  await merchantPage.getByLabel('商品或服务资料').fill('提供上门空调清洗服务');
  await merchantPage.getByLabel('价格与条件').fill('价格需联系商家确认');
  await merchantPage.getByLabel('优惠与售卖策略').fill('目前无已确认优惠');
  await merchantPage.getByLabel('欢迎语').fill('您好，我是 AI 客服。');
  await merchantPage.getByLabel('资料不足时的回复').fill('资料不足，请联系商家核实。');
  await merchantPage.getByRole('button', { name: '创建客服草稿' }).click();
  await expect(merchantPage.getByText(`已创建客服草稿「${assistantName}」`)).toBeVisible();
  await expect(merchantPage.getByRole('link', { name: '进入客服配置、试聊和发布' })).toBeVisible();
  await expect(
    merchantPage.locator('.assistant-workspace-list').getByRole('link', { name: assistantName }),
  ).toBeVisible();
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
  await merchantPage.reload();
  await expect(merchantPage.getByRole('option', { name: '本地生活服务 · v1' })).toHaveCount(0);
  await merchantPage.getByRole('link', { name: assistantName }).click();
  await expect(merchantPage.getByRole('heading', { name: assistantName })).toBeVisible();
  const assistantUrl = merchantPage.url();
  for (const [name, fragment, heading] of [
    ['客服草稿', 'draft', '草稿修订 1'],
    ['知识库', 'knowledge', '商家确认'],
    ['测试与发布', 'release', '发布前试聊'],
  ] as const) {
    await merchantNavigation.getByRole('link', { name, exact: true }).click();
    await expect(merchantPage).toHaveURL(`${assistantUrl}#${fragment}`);
    await expect(merchantPage.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await expect(merchantPage.getByText(referenceNotes)).toHaveCount(0);
  await merchantPage.getByLabel(/我已逐项核对以上资料/u).check();
  await merchantPage.getByRole('button', { name: '确认当前草稿资料' }).click();
  await expect(merchantPage.getByText('当前草稿资料已确认')).toBeVisible();
  await expect(merchantPage.getByRole('button', { name: '确认发布 AI 客服' })).toBeEnabled();
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
  await operatorPage.reload();
  const assistantState = operatorPage
    .locator('.ops-assistant-list li')
    .filter({ hasText: assistantName });
  await expect(assistantState).toContainText('已发布');

  const consumerPage = sharedContext ? await sharedContext.newPage() : await browser.newPage();
  await consumerPage.goto(publicUrl!);
  await expect(consumerPage.getByRole('heading', { name: assistantName })).toBeVisible();
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
    data: { releaseRef: string };
  };
  const firstReleaseRef = firstSessionPayload.data.releaseRef;
  const answer = consumerPage.getByText(
    '我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。',
  );
  await expect(answer).toBeVisible({ timeout: 60_000 });
  const merchantId = /\/workspace\/([0-9a-f]{32})(?:\/|$)/u.exec(
    new URL(managementUrl).pathname,
  )?.[1];
  expect(merchantId).toMatch(/^[0-9a-f]{32}$/u);
  await merchantPage.goto(`${merchantBase}/workspace/${merchantId}/conversations`);
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
  await merchantPage.getByRole('link', { name: '编辑对应客服的资料' }).click();
  await expect(merchantPage.getByRole('heading', { name: assistantName })).toBeVisible();
  await merchantPage
    .getByLabel('商品或服务资料')
    .fill('提供上门空调清洗服务，也提供洗衣机清洁咨询');
  await merchantPage.getByRole('button', { name: '保存草稿修订' }).click();
  await expect(merchantPage.getByText(/草稿已保存，原有资料确认已失效/u)).toBeVisible();
  await merchantPage.reload();
  await expect(merchantPage.getByText('资料待确认')).toBeVisible();
  await merchantPage.getByLabel(/我已逐项核对以上资料/u).check();
  await merchantPage.getByRole('button', { name: '确认当前草稿资料' }).click();
  await expect(merchantPage.getByText('当前草稿资料已确认')).toBeVisible();
  await merchantPage.reload();
  await merchantPage.getByLabel(/我确认发布当前修订/u).check();
  await merchantPage.getByRole('button', { name: '确认发布 AI 客服' }).click();
  await expect(merchantPage.getByText('Release #2 已发布。')).toBeVisible();
  await expect(merchantPage.locator('a[href^="http://127.0.0.1:3001/a/"]').first()).toHaveAttribute(
    'href',
    publicUrl!,
  );

  await consumerPage.reload();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  const publicSlug = new URL(publicUrl!).pathname.split('/')[2]!;
  const latestReleaseRef = await consumerPage.evaluate(async (slug) => {
    const response = await fetch(`/api/v1/public/assistants/${slug}`);
    const envelope = (await response.json()) as { data: { releaseRef: string } };
    return envelope.data.releaseRef;
  }, publicSlug);
  expect(latestReleaseRef).not.toBe(firstReleaseRef);
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
});
