import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  loadDatabaseConfig,
  MySqlMarketplaceRepository,
} from '../../packages/database/src/index.js';

const env = process.env,
  loaded = loadDatabaseConfig();
if (
  !loaded.configured ||
  env['APP_ENV'] !== 'test' ||
  env['H5CS_MARKETPLACE_MODE'] !== 'public-free' ||
  !env['H5CS_A6_EVIDENCE']
)
  throw Error('Explicit A6 local fixture required');
const db = loaded.config,
  repo = new MySqlMarketplaceRepository(db, env['MERCHANT_PHONE_LOOKUP_KEY']);
async function sql(statement: string, values: (string | number | Buffer)[] = []) {
  const c = await db.openConnection();
  try {
    return (await c.execute(statement, values))[0] as unknown as Record<string, unknown>[];
  } finally {
    await c.end();
  }
}
async function details(page: Page, text: string) {
  const summary = page.locator('summary').filter({ hasText: text });
  if (!(await summary.evaluate((e) => e.parentElement?.hasAttribute('open'))))
    await summary.click();
}
async function screenshot(page: Page, name: string, project: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: `${env['H5CS_A6_EVIDENCE']}/${project}-${name}.png`,
    fullPage: true,
  });
}

test.afterEach(async ({ browser }, info) => {
  if (info.status === info.expectedStatus) return;
  let index = 0;
  for (const context of browser.contexts()) {
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      const prefix = `${env['H5CS_A6_EVIDENCE']}/${info.project.name}-failure-${index++}`;
      await p.screenshot({ path: prefix + '.png', fullPage: true }).catch(() => {});
      const text = await p
        .locator('body')
        .innerText()
        .catch(() => 'unavailable');
      await writeFile(
        prefix + '.json',
        JSON.stringify({
          pathname: new URL(p.url()).pathname,
          text: text
            .slice(0, 8000)
            .replace(/1[3-9][0-9]{9}/gu, '[test-phone]')
            .replace(/[A-Za-z0-9_-]{40,}/gu, '[opaque]'),
        }),
      );
    }
  }
});

test('native H5 free registration to versioned consumer conversation, repeat login and product states', async ({
  page,
  browser,
}, info) => {
  const phone = `139${String(randomInt(10000000, 99999999))}`,
    password = randomBytes(24).toString('base64url');
  await page.goto('http://127.0.0.1:3000/console/product');
  await expect(page.getByText(/有效期暂不限，AI调用次数暂不限/)).toBeVisible();
  await expect(page.getByRole('link', { name: '免费领取并开通 →', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /商家开通二维码/ })).toHaveJSProperty(
    'naturalWidth',
    640,
  );
  await screenshot(page, 'public-product-and-activation-qr', info.project.name);
  await page.getByRole('link', { name: '免费领取并开通 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: '0元领取你的AI客服' })).toBeVisible();
  await expect(page.getByLabel('商家名称', { exact: true })).toBeInViewport();
  expect((await page.getByLabel('商家名称', { exact: true }).boundingBox())!.y).toBeGreaterThan(80);
  await screenshot(page, 'claim-empty', info.project.name);
  const claim = async (target = page) => {
    await target.getByLabel('商家名称', { exact: true }).fill('合成H5自助商家');
    await target.getByLabel('手机号', { exact: true }).fill(phone);
    await target.getByLabel('密码（已有账号须原密码）').fill(password);
    await target.getByRole('checkbox', { name: /我已了解0元领取/ }).check();
    await target.getByRole('checkbox', { name: /已有商家时/ }).check();
    await target.getByRole('button', { name: '0元领取并进入我的后台' }).click();
    await expect(target).toHaveURL(/\/[0-9a-f]{32}\/drafts\/[0-9a-f]{32}$/);
  };
  await claim();
  await expect(page.getByText(/暂不限次数（已记录0次调用尝试）/)).toBeVisible();
  const draftUrl = page.url(),
    parts = new URL(draftUrl).pathname.split('/'),
    merchantId = parts[1]!,
    assistantId = parts[3]!,
    base = `http://127.0.0.1:3000/${merchantId}`;
  await expect(page.getByLabel('细分行业')).toHaveValue('');
  await expect(page.getByText('尚未发布', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('细分行业')).toHaveValue('');
  await page.goto('http://127.0.0.1:3000/console/marketplace');
  await expect(page).toHaveURL(base);
  const repeatContext = await browser.newContext();
  const repeatPage = await repeatContext.newPage();
  await repeatPage.goto('http://127.0.0.1:3000/console/marketplace');
  await claim(repeatPage);
  expect(repeatPage.url()).toBe(draftUrl);
  await repeatContext.close();
  await page.goto(draftUrl);
  await page.getByLabel('细分行业').fill('家电清洗（本地合成）');
  await page.getByLabel('业务范围').fill('提供家用空调清洗咨询');
  await page.getByLabel('商品或服务资料').fill('提供上门空调清洗服务');
  await details(page, '交易规则');
  await page.getByLabel('价格与条件').fill('价格需联系商家确认');
  await page.getByLabel('优惠与售卖策略').fill('暂无已确认优惠');
  await details(page, '回复设置');
  await page.getByLabel('欢迎语').fill('您好，我是本地合成 AI 客服。');
  await page.getByLabel('资料不足时的回复').fill('资料不足，请联系商家核实。');
  await page.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(page).toHaveURL(`${base}/knowledge/${assistantId}`);
  const materials = page.getByRole('region', { name: '基础材料管理' });
  await materials.getByLabel('选择基础材料').setInputFiles({
    name: '本地合成服务说明.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      '提供上门空调清洗咨询，预约需提前1天；不提供安装服务。价格和优惠需商家确认。',
    ),
  });
  await materials.getByRole('button', { name: '上传并提取文字', exact: true }).click();
  await expect(materials.getByRole('status')).toContainText('已保存');
  await materials.getByRole('checkbox', { name: /我同意将所选材料的文字/ }).check();
  await materials.getByRole('button', { name: 'AI 整理所选材料', exact: true }).click();
  await expect(materials.getByLabel('知识整理稿', { exact: true })).toHaveValue(/预约需提前1天/);
  await materials.getByRole('checkbox', { name: /我已核对整理稿/ }).check();
  await materials.getByRole('button', { name: '保存整理稿到客服草稿', exact: true }).click();
  await expect(materials.getByRole('status')).toContainText('知识已保存到草稿');
  await screenshot(page, 'knowledge', info.project.name);
  await page.getByRole('link', { name: '下一步：效果试聊', exact: true }).click();
  await page.getByLabel('试聊问题').fill('你们提供什么服务？');
  await page.getByRole('button', { name: '发送测试问题' }).click();
  await expect(page.locator('.assistant-preview-answer')).toContainText('本地模型夹具');
  await page.locator('.preview-verdict-form').getByRole('checkbox').check();
  await page.getByRole('button', { name: '回答合格，允许发布本修订', exact: true }).click();
  await expect(page.getByText('本修订试聊已判定通过', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '下一步：发布分享', exact: true }).click();
  await page.getByLabel(/我已核对以上资料，并确认向消费者公开发布当前修订/).check();
  await page.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }).click();
  const link = page.locator('a[href^="http://127.0.0.1:3001/a/"]').first();
  await expect(link).toBeVisible();
  const publicUrl = (await link.getAttribute('href'))!;
  await expect(page.getByText(/本地测试客户咨询码/)).toBeVisible();
  await expect(page.getByRole('img', { name: '扫码打开消费者 AI 客服' }).first()).toBeVisible();
  await screenshot(page, 'published-test-qr', info.project.name);
  const deviceContext = {
    viewport: info.project.use.viewport ?? { width: 1280, height: 720 },
    isMobile: info.project.name === 'mobile',
    hasTouch: info.project.name === 'mobile',
  };
  const old = await browser.newContext(deviceContext),
    oldPage = await old.newPage();
  oldPage.on('pageerror', (error) => {
    void writeFile(
      `${env['H5CS_A6_EVIDENCE']}/${info.project.name}-consumer-error.txt`,
      String(error).replace(/[A-Za-z0-9_-]{40,}/g, '[opaque]'),
    );
  });
  await oldPage.goto(publicUrl);
  await oldPage.screenshot({
    path: `${env['H5CS_A6_EVIDENCE']}/${info.project.name}-consumer-initial.png`,
    fullPage: true,
  });
  const ask = async (p: Page, q: string) => {
    await expect(p.getByRole('textbox', { name: '输入想咨询的问题' })).toBeEnabled({
      timeout: 20000,
    });
    await p.getByRole('textbox', { name: '输入想咨询的问题' }).fill(q);
    await p.getByRole('button', { name: '发送消息', exact: true }).click();
  };
  await ask(oldPage, '你们提供什么服务？');
  await expect(oldPage.getByText(/本地模型夹具：提供上门空调清洗服务/).last()).toBeVisible();
  await page.goto(base + '/conversations');
  await page.locator('.merchant-conversation-list a').first().click();
  await page.getByRole('link', { name: '改进这条回答', exact: true }).first().click();
  await page
    .getByLabel('商家期望答案（真实有效的事实和处理方式）')
    .fill('提供上门空调清洗服务；也提供洗衣机清洁咨询。');
  await page.getByRole('button', { name: '建立改进任务', exact: true }).click();
  await page.getByLabel(/已核对真实事实和适用条件/).check();
  await page.getByRole('button', { name: '应用修正到草稿 FAQ', exact: true }).click();
  await expect(page.getByText(/修正已写入草稿修订/)).toBeVisible();
  await page.getByLabel(/同意将当前草稿的业务资料和本条问题/).check();
  await page.getByRole('button', { name: '发送问题并记录复测', exact: true }).click();
  await expect(page.getByRole('button', { name: '符合预期，判定通过', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '符合预期，判定通过', exact: true }).click();

  await page.goto(`${base}/preview/${assistantId}`);
  await page.getByLabel('试聊问题').fill('你们提供什么服务？');
  await page.getByRole('button', { name: '发送测试问题' }).click();
  await expect(page.locator('.assistant-preview-answer')).toContainText('也提供洗衣机清洁咨询');
  await page.locator('.preview-verdict-form').getByRole('checkbox').check();
  await page.getByRole('button', { name: '回答合格，允许发布本修订', exact: true }).click();
  await expect(page.getByText('本修订试聊已判定通过', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '下一步：发布分享', exact: true }).click();
  await page.getByLabel(/我已核对以上资料，并确认向消费者公开发布当前修订/).check();
  await page.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }).click();
  await expect(page.getByText(/第 2 版已发布/)).toBeVisible();
  await expect(link).toHaveAttribute('href', publicUrl);
  await ask(oldPage, '你们提供什么服务？');
  await expect(oldPage.getByText(/本地模型夹具：提供上门空调清洗服务/)).toHaveCount(2);
  await expect(oldPage.getByRole('textbox', { name: '输入想咨询的问题' })).toBeEnabled();
  await expect(oldPage.getByText(/也提供洗衣机清洁咨询/)).toHaveCount(0);
  await oldPage.reload();
  await expect(oldPage.getByText(/本地模型夹具/).first()).toBeVisible();
  const fresh = await browser.newContext(deviceContext),
    freshPage = await fresh.newPage();
  await freshPage.goto(publicUrl);
  await ask(freshPage, '你们提供什么服务？');
  await expect(freshPage.getByText(/也提供洗衣机清洁咨询/)).toBeVisible();
  await screenshot(freshPage, 'consumer-new-version', info.project.name);
  // Exhaust only this synthetic grant. Rules still work without a supplier call; paid-path failure is explicit.
  await sql(
    'UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET model_call_limit=model_calls_reserved WHERE a.merchant_id=?',
    [Buffer.from(merchantId, 'hex')],
  );
  const callsBefore = await (await page.request.get('http://127.0.0.1:9020/healthz')).json();
  await ask(freshPage, '转人工');
  await expect(freshPage.getByText(/此窗口不实时转接人工/)).toBeVisible();
  await ask(freshPage, '商品有哪些？');
  await expect(freshPage.getByText(/商家的\s*AI\s*服务额度已用尽/)).toBeVisible();
  const callsAfter = await (await page.request.get('http://127.0.0.1:9020/healthz')).json();
  expect(callsAfter.calls).toBe(callsBefore.calls);
  for (const status of ['paused', 'expired']) {
    await sql(
      `UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET e.status=?,e.expires_at=${status === 'expired' ? 'DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY)' : 'DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 DAY)'} WHERE a.merchant_id=?`,
      [status === 'expired' ? 'active' : 'paused', Buffer.from(merchantId, 'hex')],
    );
    const restricted = await browser.newContext(deviceContext),
      restrictedPage = await restricted.newPage();
    await restrictedPage.goto(publicUrl);
    await ask(restrictedPage, '转人工');
    await expect(restrictedPage.getByText(/商家的\s*AI\s*服务已暂停或过期/)).toBeVisible();
    await restrictedPage.getByRole('button', { name: '继续提问', exact: true }).click();
    await ask(restrictedPage, '有什么商品？');
    await expect(restrictedPage.getByText(/商家的\s*AI\s*服务已暂停或过期/)).toBeVisible();
    await restricted.close();
    await page.goto(draftUrl);
    await expect(page).toHaveURL('http://127.0.0.1:3000/console/marketplace/status');
    await expect(
      page.getByRole('heading', { name: status === 'paused' ? 'AI 服务已暂停' : 'AI 服务已过期' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('账号或手机号').fill(phone);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录商家后台' }).click();
    await expect(page).toHaveURL(/\/marketplace\/status$/);
    await screenshot(page, 'state-' + status, info.project.name);
    const denied = await page.request.post(`${base}/writing/generate`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
      data: {},
    });
    expect(denied.status()).toBe(403);
  }
  await sql(
    "UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET status='active', expires_at=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 DAY) WHERE a.merchant_id=?",
    [Buffer.from(merchantId, 'hex')],
  );
  await page.getByRole('button', { name: '刷新核查产品状态', exact: true }).click();
  await expect(page).toHaveURL(base);
  await page.goto(draftUrl);
  await expect(page.getByLabel('商品或服务资料')).toHaveValue(/洗衣机/);
  // All three private model endpoints share the actual generator boundary and retain safe codes.
  const zeroAccount = await repo.claimFree({
    merchantName: '合成零额度商家',
    phone: `137${String(randomInt(10000000, 99999999))}`,
    password,
    requestId: 'local-http-quota',
  });
  await sql(
    'UPDATE marketplace_entitlement e JOIN marketplace_allocation a ON a.subject_digest=e.subject_digest AND a.product=e.product SET model_call_limit=0 WHERE a.merchant_id=?',
    [Buffer.from(zeroAccount.merchantId, 'hex')],
  );
  const samples = [
    [
      'preview',
      {
        merchantId: zeroAccount.merchantId,
        facts: {
          assistantName: '合成',
          industry: '合成',
          businessScope: '合成',
          materialsSummary: '合成',
          pricingSummary: '未确认',
          promotionSummary: '未确认',
          insufficientInfoMessage: '未确认',
        },
        question: '合成价格？',
      },
    ],
    [
      'writing',
      {
        merchantId: zeroAccount.merchantId,
        field: 'pricingSummary',
        brief: '合成29元',
        currentText: '',
      },
    ],
    ['knowledge', { merchantId: zeroAccount.merchantId, text: '合成材料' }],
  ] as const;
  for (const [endpoint, payload] of samples) {
    const response = await page.request.post(`http://127.0.0.1:3011/internal/${endpoint}`, {
      headers: { 'x-h5cs-preview-token': env['PREVIEW_AUTH_TOKEN']! },
      data: payload,
    });
    expect(response.status()).toBe(429);
    expect((await response.json()).error.code).toBe('MARKETPLACE_QUOTA_EXHAUSTED');
  }
  await writeFile(
    `${env['H5CS_A6_EVIDENCE']}/${info.project.name}-browser-result.json`,
    JSON.stringify(
      {
        newRegistration: true,
        repeatedClaimSameIds: true,
        legacyLogin: true,
        states: ['paused', 'expired'],
        writeDenied: true,
        fixedUrl: true,
        oldAndNewSessions: true,
        quotaEveryModelEndpoint: true,
        ruleReplyNoModelReservation: true,
        localFixtureOnly: true,
        touchEmulated: info.project.name === 'mobile',
        fakeCallsAtExhaustionBefore: callsBefore.calls,
        fakeCallsAtExhaustionAfter: callsAfter.calls,
        merchantId,
        assistantId,
        publicUrl,
      },
      null,
      2,
    ),
  );
  await old.close();
  await fresh.close();
});
