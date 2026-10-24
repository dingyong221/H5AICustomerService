import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Fixture = { device: string; phone: string; password: string; merchantId: string };
const fixtures: Fixture[] = JSON.parse(process.env['H5CS_GOV_FIXTURES'] ?? '[]');
const merchantBase = 'http://127.0.0.1:3000';
const evidence = process.env['H5CS_GOV_EVIDENCE'];
if (!evidence) throw new Error('Local evidence directory is required');

async function openDetails(page: Page, text: string) {
  const summary = page.locator('summary').filter({ hasText: text });
  await expect(summary).toHaveCount(1);
  if (!(await summary.evaluate((element) => element.parentElement?.hasAttribute('open'))))
    await summary.click();
}
async function step(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '客服发布步骤' })
    .getByRole('link', { name: new RegExp('^' + name) })
    .click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
}
async function trial(page: Page) {
  await page.getByLabel('试聊问题', { exact: true }).fill('你们提供什么服务，清洗价格是多少？');
  await page.getByRole('button', { name: '发送测试问题', exact: true }).click();
  await expect(page.getByText('本地模型测试回复：', { exact: false }).first()).toBeVisible();
  const verdict = page.locator('.preview-verdict-form');
  await expect(verdict).toBeVisible();
  await verdict.getByRole('checkbox').check();
  await verdict.getByRole('button', { name: '回答合格，允许发布本修订', exact: true }).click();
  await expect(page.getByText('本修订试聊已判定通过', { exact: true })).toBeVisible();
}
async function publish(page: Page) {
  await step(page, '发布分享');
  await page
    .getByRole('checkbox', {
      name: '我已核对以上资料，并确认向消费者公开发布当前修订。',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }).click();
  const card = page.locator('#consumer-link');
  await expect(card).toBeVisible();
  const link = card.locator('a[href*="/a/"]').first();
  await expect(link).toHaveAttribute('href', /^http:\/\/127\.0\.0\.1:3001\/a\/[a-z0-9-]+$/u);
  return (await link.getAttribute('href'))!;
}
async function ask(page: Page, text: string, expected: string) {
  await page.getByLabel('输入想咨询的问题', { exact: true }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message-row--assistant').last()).toContainText(expected);
}
async function shot(page: Page, name: string) {
  // A visible fixture label prevents these real application screenshots being mistaken for live Qwen.
  await page.evaluate(() => {
    const banner = document.createElement('div');
    banner.id = 'local-test-watermark';
    banner.textContent = '本地合成验收 · 回环确定性模型 · 非真实千问 / 非正式业务入口';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:999;background:#fff4ce;color:#272014;padding:8px;font:12px sans-serif';
    document.body.prepend(banner);
  });
  await page.screenshot({ path: join(evidence!, name + '.png'), fullPage: true });
  await page.locator('#local-test-watermark').evaluate((element) => element.remove());
}

test('merchant governance, fixed consumer URL, emergency withdrawal and real Next history', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const fixture = fixtures.find((value) => value.device === testInfo.project.name);
  if (!fixture) throw new Error('Synthetic authenticated merchant fixture missing');
  const device = fixture.device;
  const context = await browser.newContext({
    viewport: device === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    hasTouch: device === 'mobile',
    isMobile: device === 'mobile',
  });
  const page = await context.newPage();
  const marks: string[] = [];
  const mark = async (value: string) => {
    marks.push(value);
    await writeFile(
      join(evidence!, device + '-progress.json'),
      JSON.stringify({ verified: marks }, null, 2),
    );
  };
  try {
    await page.goto(merchantBase + '/console/account/login?merchant=' + fixture.merchantId);
    await page.getByLabel('账号或手机号', { exact: true }).fill(fixture.phone);
    await page.getByLabel('密码', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: '登录商家后台', exact: true }).click();
    await expect(page).toHaveURL(merchantBase + '/' + fixture.merchantId);
    await page.getByRole('link', { name: '新建客服', exact: true }).first().click();
    await page.getByLabel('客服名称', { exact: true }).fill('本地验收清洗客服 ' + device);
    await page.getByLabel('细分行业', { exact: true }).fill('家用电器清洗');
    await page.getByLabel('业务范围', { exact: true }).fill('提供上门空调清洗；不提供安装服务。');
    await page.getByLabel('商品或服务资料', { exact: true }).fill('提供上门空调清洗服务。');
    await openDetails(page, '交易规则');
    await page.getByLabel('价格与条件', { exact: true }).fill('清洗：79元/次');
    await page.getByLabel('优惠与售卖策略', { exact: true }).fill('目前没有优惠活动。');
    await openDetails(page, '回复设置');
    await page.getByLabel('欢迎语', { exact: true }).fill('您好，我是本地合成AI客服。');
    await page
      .getByLabel('资料不足时的回复', { exact: true })
      .fill('资料尚未确认，请通过原购买渠道联系商家。');
    await page
      .getByLabel('人工联系说明（可选）', { exact: true })
      .fill('测试联系说明；不提供真实联系渠道。');
    await page.getByRole('button', { name: '创建客服草稿', exact: true }).click();
    await expect(page).toHaveURL(new RegExp('/' + fixture.merchantId + '/knowledge/[0-9a-f]{32}$'));
    const assistantId = page.url().split('/').at(-1)!;
    await mark('authenticatedCreate');
    await expect(page.getByLabel('知识生效范围')).toContainText('/ 4000 字');
    await expect(page.getByLabel('知识生效范围')).toContainText('上传不等于生效');
    await page.getByLabel('选择基础材料', { exact: true }).setInputFiles({
      name: '本地合成服务说明.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('预约需提前1天；不提供安装服务。'),
    });
    await page.getByRole('button', { name: '上传并提取文字', exact: true }).click();
    await expect(page.getByText('本地合成服务说明.txt', { exact: false }).first()).toBeVisible();
    await page
      .getByRole('checkbox', { name: /我同意将所选材料的文字发送至阿里云千问整理/ })
      .check();
    await page.getByRole('button', { name: 'AI 整理所选材料', exact: true }).click();
    await expect(page.getByLabel('知识整理稿', { exact: true })).not.toHaveValue('');
    await page.getByRole('checkbox', { name: /我已核对整理稿与现有价格/ }).check();
    await shot(page, device + '-knowledge-review');
    await page.getByRole('button', { name: '保存并进入效果试聊', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: '效果试聊', exact: true }),
    ).toBeVisible();
    await mark('uploadOrganizeSaveContinue');

    await step(page, '发布分享');
    await expect(
      page.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }),
    ).toBeDisabled();
    await mark('unreviewedRevisionCannotPublish');
    await step(page, '效果试聊');
    await trial(page);
    const publicUrl = await publish(page);
    const old = await context.newPage();
    await old.goto(publicUrl);
    await ask(old, '清洗如何收费？', '79元');
    await mark('firstPublishedConsumerReply');

    // Actual Next links + history restore, not only the isolated router guard test.
    await step(page, '基础资料');
    const form = page.locator('.assistant-edit-form');
    const original = await form.getByLabel('商品或服务资料', { exact: true }).inputValue();
    await form
      .getByLabel('商品或服务资料', { exact: true })
      .fill(original + '\n本地尚未保存的文字');
    const answers: boolean[] = [false, false, true];
    let dialogs = 0;
    const handleDialog = async (dialog: import('@playwright/test').Dialog) => {
      dialogs++;
      if (answers.shift()) await dialog.accept();
      else await dialog.dismiss();
    };
    page.on('dialog', handleDialog);
    const historyLength = await page.evaluate(() => history.length);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.evaluate(() => history.back());
      await expect.poll(() => dialogs).toBe(attempt);
      await expect(form.getByLabel('商品或服务资料', { exact: true })).toHaveValue(
        original + '\n本地尚未保存的文字',
      );
      await expect(page).toHaveURL(
        merchantBase + '/' + fixture.merchantId + '/drafts/' + assistantId,
      );
    }
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await page.evaluate(() => history.back());
    await expect(
      page.getByRole('heading', { level: 1, name: '发布分享', exact: true }),
    ).toBeVisible();
    page.off('dialog', handleDialog);
    await mark('nextBackCancelTwiceAndAcceptPreservesText');

    await step(page, '基础资料');
    await openDetails(page, '交易规则');
    await form.getByLabel('价格与条件', { exact: true }).fill('清洗：89元/次');
    await form.getByLabel('商品或服务资料', { exact: true }).fill(original + '\n清洗：79元/次');
    await form.getByRole('button', { name: '保存草稿修订', exact: true }).click();
    await expect(page.getByLabel('当前修订发布检查')).toContainText('报价不一致');
    let savedBackPrompts = 0;
    const savedBackDialog = async (dialog: import('@playwright/test').Dialog) => {
      savedBackPrompts++;
      await dialog.dismiss();
    };
    page.on('dialog', savedBackDialog);
    await page.evaluate(() => history.back());
    await expect(
      page.getByRole('heading', { level: 1, name: '发布分享', exact: true }),
    ).toBeVisible();
    expect(savedBackPrompts).toBe(0);
    page.off('dialog', savedBackDialog);
    await mark('nextSavedFormBackDoesNotPrompt');
    await expect(
      page.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }),
    ).toBeDisabled();
    await mark('conflictingFactsBlockPublication');
    await step(page, '基础资料');
    await form.getByLabel('商品或服务资料', { exact: true }).fill(original);
    await openDetails(page, '交易规则');
    await form.getByLabel('优惠与售卖策略', { exact: true }).fill('优惠有效期至：2020-01-01');
    await form.getByRole('button', { name: '保存草稿修订', exact: true }).click();
    await expect(page.getByLabel('当前修订发布检查')).toContainText('截止日期');
    await mark('expiredPromotionBlocksPublication');
    await form.getByLabel('优惠与售卖策略', { exact: true }).fill('目前没有优惠活动。');
    await form.getByRole('button', { name: '保存草稿修订', exact: true }).click();
    await expect(page.getByLabel('当前修订发布检查')).toContainText('尚未试聊本修订');
    await step(page, '效果试聊');
    await trial(page);
    expect(await publish(page)).toBe(publicUrl);
    await ask(old, '旧咨询清洗价格再确认？', '79元');
    const fresh = await context.newPage();
    await fresh.goto(publicUrl);
    await ask(fresh, '新咨询清洗价格是多少？', '89元');
    await mark('newVersionSameUrlAndOldSessionSnapshot');

    await step(page, '基础资料');
    await openDetails(page, '修改客服名称');
    await page
      .locator('.assistant-rename')
      .getByLabel('客服名称', { exact: true })
      .fill('本地验收新客服名称 ' + device);
    await page.getByRole('button', { name: '保存客服名称', exact: true }).click();
    await expect(page.getByLabel('当前修订发布检查')).toContainText('尚未试聊本修订');
    // A draft rename must not invalidate the already published public snapshot.
    const unchanged = await context.newPage();
    await unchanged.goto(publicUrl);
    await expect(unchanged.getByRole('heading', { level: 1 })).toHaveText(
      '本地验收清洗客服 ' + device,
    );
    await unchanged.close();
    await step(page, '效果试聊');
    await trial(page);
    expect(await publish(page)).toBe(publicUrl);
    const named = await context.newPage();
    await named.goto(publicUrl);
    await expect(named.getByRole('heading', { level: 1 })).toHaveText(
      '本地验收新客服名称 ' + device,
    );
    await named.close();
    await mark('renameInvalidatesCheckButPreservesOldPublicSnapshotAndSlug');

    await openDetails(page, '错误价格或紧急下架？停止全部已发布版本');
    await page
      .getByLabel('撤回原因', { exact: true })
      .fill('本地合成验收：核实报价，停止旧资料回答。');
    await page.getByRole('checkbox', { name: /我确认停止此客服全部已发布版本及已有咨询/ }).check();
    await page.getByRole('button', { name: '确认紧急撤回全部版本', exact: true }).click();
    await expect(page.getByLabel('当前修订发布检查')).toContainText('已撤回');
    await expect(
      page.getByRole('button', { name: '确认资料并发布 AI 客服', exact: true }),
    ).toBeDisabled();
    await old.getByLabel('输入想咨询的问题', { exact: true }).fill('撤回后请再确认旧价格');
    await old.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(old.getByText('商家已撤回此前的客服资料', { exact: false })).toBeVisible();
    await expect(old.getByRole('button', { name: '查看最新客服', exact: true })).toBeVisible();
    await expect(old.getByRole('button', { name: '重试回复', exact: true })).toHaveCount(0);
    const withdrawn = await context.newPage();
    await withdrawn.goto(publicUrl);
    await expect(withdrawn.getByRole('heading', { name: /咨询服务未开放/ })).toBeVisible();
    await withdrawn.close();
    await shot(page, device + '-withdrawn-governance');
    await shot(old, device + '-consumer-withdrawn');
    await mark('emergencyWithdrawalEndsOldSessionsAndRequiresNewTrial');
    await step(page, '效果试聊');
    await trial(page);
    expect(await publish(page)).toBe(publicUrl);
    await old.getByRole('button', { name: '查看最新客服', exact: true }).click();
    await expect(old.getByRole('heading', { level: 1 })).toHaveText('本地验收新客服名称 ' + device);
    await ask(old, '恢复后新咨询价格是多少？', '89元');
    await shot(old, device + '-consumer-restored');
    await shot(page, device + '-published');
    await mark('republishRestoresSameUrlWithoutRevivingWithdrawnSession');
    await writeFile(
      join(evidence!, device + '-browser-result.json'),
      JSON.stringify(
        {
          passed: true,
          mobileTouchEmulation: device === 'mobile',
          publicUrl,
          assistantId,
          stages: marks,
          paidSupplierCalls: 0,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await shot(page, device + '-failure').catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
});
