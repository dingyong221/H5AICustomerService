import { randomBytes } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import {
  EXECUTION_STATE_HEADER,
  executionStateSchema,
  runtimeControlRequestSchema,
  type RuntimeControlRequest,
} from '../../packages/contracts/src/runtime-execution';
import { requestIdSchema } from '../../packages/contracts/src/envelope';
import { authoringTaskSchema } from '../../packages/contracts/src/authoring-task';
import { lastPreviewSession } from './authoring-async';

type Inputs = {
  browser: Browser;
  operatorPage: Page;
  merchantPage: Page;
  consumerPage: Page;
  operatorBase: string;
  managementUrl: string;
  assistantId: string;
  publicUrl: string;
  sessionHandle: string;
};
type ActionPacket = { url: string; action: string; contentType: string; args: unknown[] };
const header = EXECUTION_STATE_HEADER.toLowerCase();
const requestId = () => `runtime_${randomBytes(16).toString('hex')}`;

function revision(section: Locator) {
  return section
    .getByText(/^当前修订 \d+ · 有效状态 /u)
    .textContent()
    .then((text) => {
      const value = text?.match(/^当前修订 (\d+) /u)?.[1];
      if (!value) throw new Error('Runtime control revision is missing');
      return value;
    });
}
async function change(section: Locator, page: Page, action: 'pause' | 'resume') {
  const before = BigInt(await revision(section));
  const title = action === 'pause' ? '确认暂停运行' : '确认恢复运行';
  await section
    .getByLabel('操作原因（仅运营审计）', { exact: true })
    .fill(`合成浏览器验收：${action}运行范围`);
  const consent = section.getByRole('checkbox', { name: /此操作区别于商家业务停用/u });
  await expect(consent).not.toBeChecked();
  await expect(consent).toHaveAttribute('required', '');
  await consent.check();
  const submitted = page.waitForRequest(
    (request) => request.method() === 'POST' && !!request.headers()['next-action'],
  );
  await section.getByRole('button', { name: title, exact: true }).click();
  const request = await submitted;
  await expect(
    section
      .getByRole('status')
      .filter({ hasText: `原操作收据：${action === 'pause' ? '暂停' : '恢复'}` }),
  ).toBeVisible();
  expect(BigInt(await revision(section))).toBe(before + 1n);
  const args: unknown = JSON.parse(request.postData() ?? 'null');
  if (!Array.isArray(args) || !runtimeControlRequestSchema.safeParse(args[0]).success)
    throw new Error('Actual Next action arguments no longer match the frozen runtime contract');
  // Only the action ID/content type and synthetic JSON arguments are retained.
  // Session cookies and other request headers are never copied or logged.
  const packet: ActionPacket = {
    url: request.url(),
    action: request.headers()['next-action']!,
    contentType: request.headers()['content-type'] ?? '',
    args,
  };
  await section.getByRole('button', { name: '刷新当前状态后再操作', exact: true }).click();
  await expect(
    section.getByRole('button', {
      name: action === 'pause' ? '确认恢复运行' : '确认暂停运行',
      exact: true,
    }),
  ).toBeEnabled();
  return packet;
}
function actionBody(packet: ActionPacket, input: RuntimeControlRequest) {
  return JSON.stringify([runtimeControlRequestSchema.parse(input), ...packet.args.slice(1)]);
}
async function readJson(page: Page, url: string) {
  const sent = page.waitForRequest(
    (request) => request.method() === 'GET' && request.url() === url,
  );
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
    return {
      status: response.status,
      execution: response.headers.get('X-H5CS-Execution-State'),
      body: (await response.json()) as unknown,
    };
  }, url);
  const request = await sent;
  expect(Object.hasOwn(request.headers(), 'origin')).toBe(false);
  expect(Object.hasOwn(request.headers(), 'x-h5cs-csrf')).toBe(false);
  return result;
}
type History = {
  request_id: string;
  data: {
    sessionHandle: string;
    releaseRef: string;
    messages: { messageId: string; content: string }[];
  };
};

export function assertUnchangedHistory(history: History, response: unknown) {
  // Request IDs describe the individual HTTP reads, not persisted business data.
  // Compare every other envelope/data field, retaining strict snapshot equality.
  requestIdSchema.parse(history.request_id);
  const requestId = requestIdSchema.parse((response as Record<string, unknown>)['request_id']);
  expect(response).toEqual({ ...history, request_id: requestId });
}

export async function verifyRuntimeControl(input: Inputs) {
  await test.step('real scoped runtime controls preserve tasks, session and manual help', async () => {
    const {
      browser,
      operatorPage,
      merchantPage,
      consumerPage,
      operatorBase,
      managementUrl,
      assistantId,
      publicUrl,
      sessionHandle,
    } = input;
    if (
      process.env['H5CS_E2E_RUNTIME_CONTROL'] !== 'true' ||
      process.env['H5CS_E2E_AUTHORING_ASYNC'] !== 'true' ||
      process.env['H5CS_E2E_KNOWLEDGE_ASYNC'] !== 'true' ||
      process.env['H5CS_E2E_PATH_MODE'] !== 'single_domain'
    )
      throw new Error('Runtime control scenario requires the explicit sixth browser mode');
    const merchantId = new URL(managementUrl).pathname.slice(1);
    expect(merchantId).toMatch(/^[a-f0-9]{32}$/u);
    expect(sessionHandle).toMatch(/^[A-Za-z0-9_-]+$/u);
    const originalPreview = lastPreviewSession(merchantPage);
    const originalRead = await readJson(merchantPage, originalPreview.taskUrl);
    expect(originalRead.status).toBe(200);
    expect(executionStateSchema.parse(originalRead.execution)).toBe('not-applicable');
    const originalTask = authoringTaskSchema.parse(originalRead.body);
    expect(originalTask.state).toBe('completed');
    const historyUrl = `http://127.0.0.1:3001/api/v1/public/sessions/${sessionHandle}/history`;
    const oldHistory = await readJson(consumerPage, historyUrl);
    expect(oldHistory.status).toBe(200);
    const history = oldHistory.body as History;
    expect(history.data.sessionHandle).toBe(sessionHandle);
    expect(history.data.messages.length).toBeGreaterThan(0);
    const assistantRepliesBefore = await consumerPage
      .locator('.message-row--assistant .message-bubble p')
      .count();
    expect(
      (await operatorPage.request.get('http://127.0.0.1:3011/internal/runtime-snapshot')).status(),
    ).toBe(404);

    let observationExposed = false;
    const inspect = (request: Request) => {
      if (
        Object.hasOwn(request.headers(), 'x-h5cs-observation-token') ||
        new URL(request.url()).pathname === '/internal/runtime-snapshot'
      )
        observationExposed = true;
    };
    const contexts = [
      ...new Set([operatorPage.context(), merchantPage.context(), consumerPage.context()]),
    ];
    for (const context of contexts) context.on('request', inspect);
    try {
      await operatorPage.goto(`${operatorBase}/#tasks`);
      const global = operatorPage.getByRole('region', { name: '全局运行控制', exact: true });
      await expect(global.getByRole('status')).toHaveText('本范围允许运行');
      await expect(
        operatorPage.getByRole('article', { name: '数据库运行观测', exact: true }),
      ).toContainText('不能当作纯供应商响应时延');
      const worker = operatorPage.getByRole('article', { name: 'Worker进程观测', exact: true });
      await expect(worker).toContainText('控制表探针：就绪');
      await expect(worker).toContainText('全局持久暂停：未暂停');
      const completedJob = operatorPage
        .locator('.runtime-job-list > li')
        .filter({ hasText: /· completed/u })
        .first();
      await expect(completedJob).toBeVisible();
      const jobId = (await completedJob.locator(':scope > code').textContent())!;
      expect(jobId).toMatch(/^[a-f0-9]{32}$/u);
      await expect(
        completedJob
          .getByRole('region', { name: '此任务运行控制', exact: true })
          .getByRole('button', { name: '确认暂停运行', exact: true }),
      ).toBeDisabled();

      const question = `暂停期间保留的合成问题 ${randomBytes(4).toString('hex')}`;
      const composer = consumerPage.getByRole('textbox', { name: '输入想咨询的问题', exact: true });
      await composer.fill(question);
      const pausePacket = await change(global, operatorPage, 'pause');
      await expect(global.getByRole('status')).toHaveText('本范围已人工暂停');
      await expect(worker).toContainText('全局持久暂停：人工暂停');
      await expect(composer).toHaveValue(question);
      const unchangedHistory = await readJson(consumerPage, historyUrl);
      expect(unchangedHistory.status).toBe(200);
      assertUnchangedHistory(history, unchangedHistory.body);
      const stillPublished = await consumerPage.request.get(
        `http://127.0.0.1:3001/api/v1/public/assistants/${new URL(publicUrl).pathname.slice(3)}`,
      );
      expect(stillPublished.status()).toBe(200); // Runtime pause is separate from business stop/withdrawal.
      const persisted = await readJson(merchantPage, originalPreview.taskUrl);
      expect(persisted.status).toBe(200);
      expect(executionStateSchema.parse(persisted.execution)).toBe('not-applicable');
      expect(authoringTaskSchema.parse(persisted.body)).toEqual(originalTask);

      // GET remains authorized without Origin; writes still require the real
      // merchant CSRF and same origin, including while runtime is paused.
      const blockedInput = {
        ...originalPreview.input,
        requestId: `authoring_${randomBytes(16).toString('hex')}`,
      };
      expect(
        (
          await merchantPage.request.post(originalPreview.collectionUrl, {
            headers: { Origin: 'http://127.0.0.1:3001' },
            data: blockedInput,
          })
        ).status(),
      ).toBe(404);
      expect(
        (
          await merchantPage.request.post(originalPreview.collectionUrl, {
            headers: { Origin: 'https://foreign.invalid', 'x-h5cs-csrf': originalPreview.csrf },
            data: blockedInput,
          })
        ).status(),
      ).toBe(404);

      await merchantPage.goto(`${managementUrl}/preview/${assistantId}`);
      const close = merchantPage.getByRole('button', { name: '关闭已结束任务', exact: true });
      await expect(close).toBeEnabled();
      merchantPage.once('dialog', (dialog) => void dialog.accept());
      await close.click();
      await merchantPage
        .getByRole('textbox', { name: '试聊问题', exact: true })
        .fill('合成验收：暂停后不应提交新模型任务');
      const deniedPreview = merchantPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url() === originalPreview.collectionUrl,
      );
      await merchantPage.getByRole('button', { name: '发送测试问题', exact: true }).click();
      const previewResponse = await deniedPreview;
      expect(previewResponse.status()).toBe(503);
      expect(executionStateSchema.parse(previewResponse.headers()[header])).toBe('paused');
      expect(await previewResponse.json()).toMatchObject({ code: 'UNAVAILABLE' });
      const deniedRequestId = (previewResponse.request().postDataJSON() as { requestId: string })
        .requestId;
      await expect(
        merchantPage.getByRole('status').filter({ hasText: 'AI 任务运行已暂停' }),
      ).toBeVisible();
      await expect(
        merchantPage.getByRole('textbox', { name: '试聊问题', exact: true }),
      ).toHaveValue('合成验收：暂停后不应提交新模型任务');
      await expect(
        merchantPage.getByRole('textbox', { name: '试聊问题', exact: true }),
      ).toBeDisabled();
      await expect(
        merchantPage.getByRole('button', { name: '发送测试问题', exact: true }),
      ).toBeDisabled();
      const notEnqueued = await readJson(
        merchantPage,
        `${originalPreview.collectionUrl}?requestId=${deniedRequestId}`,
      );
      expect(notEnqueued).toMatchObject({ status: 200, execution: 'paused', body: null });

      const sendUrl = `http://127.0.0.1:3001/api/v1/public/sessions/${sessionHandle}/messages`;
      async function sendConsumer(retry: boolean) {
        const received = consumerPage.waitForResponse(
          (response) => response.request().method() === 'POST' && response.url() === sendUrl,
        );
        await consumerPage
          .getByRole('button', { name: retry ? '重试回复' : '发送消息', exact: true })
          .click();
        return received;
      }
      const deniedConsumer = await sendConsumer(false);
      expect(deniedConsumer.status()).toBe(503);
      expect(executionStateSchema.parse(deniedConsumer.headers()[header])).toBe('paused');
      expect(await deniedConsumer.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
      const clientMessageId = (
        deniedConsumer.request().postDataJSON() as { clientMessageId: string }
      ).clientMessageId;
      await expect(
        consumerPage.getByRole('status').filter({ hasText: 'AI 回复暂时暂停' }),
      ).toBeVisible();
      await expect(
        consumerPage.locator('.message-row--visitor .message-bubble p').last(),
      ).toHaveText(question);
      const contact = consumerPage.locator('summary').filter({ hasText: '联系商家 / 人工服务' });
      if (!(await contact.evaluate((element) => element.parentElement?.hasAttribute('open'))))
        await contact.click();
      await expect(
        consumerPage.getByText('工作日9:00至18:00，请通过测试店铺订单页联系人工。', {
          exact: true,
        }),
      ).toBeVisible();
      const pausedConsumerHistory = await readJson(consumerPage, historyUrl);
      expect(pausedConsumerHistory.status).toBe(200);
      assertUnchangedHistory(history, pausedConsumerHistory.body);

      // Use a real Next action captured from UI; change to a fresh request so an
      // accidental authorization bypass cannot hide behind idempotent replay.
      const onlyMerchant = await browser.newContext();
      try {
        const cookies = (await merchantPage.context().cookies()).filter((cookie) =>
          ['h5cs_session', 'h5cs_csrf'].includes(cookie.name),
        );
        expect(cookies.some((cookie) => cookie.name === 'h5cs_session')).toBe(true);
        await onlyMerchant.addCookies(cookies);
        const page = await onlyMerchant.newPage();
        await page.goto(`${operatorBase}/#tasks`);
        const loginUrl = new URL(`${operatorBase}/login`);
        await expect(page).toHaveURL(
          (url) =>
            url.origin === loginUrl.origin &&
            url.pathname === loginUrl.pathname &&
            url.search === '' &&
            (url.hash === '' || url.hash === '#tasks'),
        );
        const forbidden = await onlyMerchant.request.post(pausePacket.url, {
          headers: {
            Origin: 'http://127.0.0.1:3001',
            'next-action': pausePacket.action,
            'content-type': pausePacket.contentType,
          },
          data: actionBody(pausePacket, {
            scope: { kind: 'job', jobId },
            action: 'pause',
            expectedRevision: '0',
            requestId: requestId(),
            reason: '商家会话无运营权限的合成负控',
            confirmed: true,
          }),
        });
        expect(forbidden.status()).toBe(200);
        const rejected = await forbidden.text();
        expect(rejected).toContain('运营登录或请求来源无效。');
        expect(rejected).not.toContain('"auditId":');
      } finally {
        await onlyMerchant.close();
      }
      const currentRevision = await revision(global);
      const foreignOrigin = await operatorPage.request.post(pausePacket.url, {
        headers: {
          Origin: 'https://foreign.invalid',
          'next-action': pausePacket.action,
          'content-type': pausePacket.contentType,
        },
        data: actionBody(pausePacket, {
          scope: { kind: 'global' },
          action: 'resume',
          expectedRevision: currentRevision,
          requestId: requestId(),
          reason: '跨来源恢复运行的合成拒绝用例',
          confirmed: true,
        }),
      });
      const rejectedOrigin = await foreignOrigin.text();
      expect(
        foreignOrigin.status() >= 400 || rejectedOrigin.includes('运营登录或请求来源无效。'),
      ).toBe(true);
      expect(rejectedOrigin).not.toContain('"auditId":');
      await operatorPage.reload();
      expect(await revision(global)).toBe(currentRevision);
      await expect(global.getByRole('status')).toHaveText('本范围已人工暂停');

      await operatorPage.setViewportSize({ width: 390, height: 844 });
      await operatorPage.goto(`${operatorBase}/merchants/${merchantId}`);
      const merchant = operatorPage.getByRole('region', { name: '此商家运行控制', exact: true });
      await expect(
        operatorPage
          .getByRole('region', { name: '商家状态管理', exact: true })
          .getByText('暂停此商家', { exact: true }),
      ).toBeVisible();
      await change(merchant, operatorPage, 'pause');
      await expect(merchant.getByRole('status')).toHaveText('本范围已人工暂停');
      await change(merchant, operatorPage, 'resume');
      await expect(merchant.getByRole('status')).toHaveText('本范围已恢复，仍受上级暂停影响');
      await expect(merchant.getByText('阻断范围：全局', { exact: true })).toBeVisible();
      expect(
        await operatorPage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      const stillGlobal = await sendConsumer(true);
      expect(stillGlobal.status()).toBe(503);
      expect(executionStateSchema.parse(stillGlobal.headers()[header])).toBe('paused');
      expect(
        (stillGlobal.request().postDataJSON() as { clientMessageId: string }).clientMessageId,
      ).toBe(clientMessageId);
      await change(merchant, operatorPage, 'pause');
      await operatorPage.goto(`${operatorBase}/#tasks`);
      await change(global, operatorPage, 'resume');
      await expect(global.getByRole('status')).toHaveText('本范围允许运行');
      const stillMerchant = await sendConsumer(true);
      expect(stillMerchant.status()).toBe(503);
      expect(executionStateSchema.parse(stillMerchant.headers()[header])).toBe('paused');
      expect(
        (stillMerchant.request().postDataJSON() as { clientMessageId: string }).clientMessageId,
      ).toBe(clientMessageId);
      await operatorPage.goto(`${operatorBase}/merchants/${merchantId}`);
      await expect(merchant.getByRole('status')).toHaveText('本范围已人工暂停');
      await change(merchant, operatorPage, 'resume');
      await expect(merchant.getByRole('status')).toHaveText('本范围允许运行');

      const resumed = await sendConsumer(true);
      expect(resumed.status()).toBe(202);
      expect(executionStateSchema.parse(resumed.headers()[header])).toBe('runnable');
      expect(
        (resumed.request().postDataJSON() as { clientMessageId: string }).clientMessageId,
      ).toBe(clientMessageId);
      const accepted = (await resumed.json()) as { data: { resultUrl: string; turnId: string } };
      const resultUrl = new URL(accepted.data.resultUrl, 'http://127.0.0.1:3001');
      expect(resultUrl.origin).toBe('http://127.0.0.1:3001');
      expect(resultUrl.pathname).toBe(
        `/api/v1/public/sessions/${sessionHandle}/turns/${accepted.data.turnId}`,
      );
      await expect(consumerPage.locator('.message-row--assistant .message-bubble p')).toHaveCount(
        assistantRepliesBefore + 1,
        { timeout: 60_000 },
      );
      let completed: unknown;
      await expect
        .poll(
          async () => {
            const read = await readJson(consumerPage, resultUrl.href);
            expect(read.status).toBe(200);
            const envelope = read.body as { data: { state: string } };
            completed = read;
            return envelope.data.state;
          },
          { timeout: 60_000 },
        )
        .toBe('completed');
      expect(completed).toMatchObject({
        execution: 'not-applicable',
        body: { data: { sessionHandle, turnId: accepted.data.turnId } },
      });
      const resumedHistory = (await readJson(consumerPage, historyUrl)).body as History;
      expect(resumedHistory.data.sessionHandle).toBe(sessionHandle);
      expect(resumedHistory.data.releaseRef).toBe(history.data.releaseRef);
      expect(resumedHistory.data.messages.slice(0, history.data.messages.length)).toEqual(
        history.data.messages,
      );
      expect(resumedHistory.data.messages).toHaveLength(history.data.messages.length + 2);
      expect(
        resumedHistory.data.messages.filter((message) => message.content === question),
      ).toHaveLength(1);
      await expect(
        consumerPage.locator('.message-row--assistant .message-bubble p').last(),
      ).toContainText('也提供洗衣机清洁咨询');
      let reloadWrites = 0;
      const countReloadWrite = (request: Request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname.startsWith('/api/v1/public/')
        )
          reloadWrites++;
      };
      consumerPage.on('request', countReloadWrite);
      try {
        await consumerPage.reload();
        await expect(
          consumerPage.locator('.message-row--visitor .message-bubble p').last(),
        ).toHaveText(question);
        const reloadedHistory = await readJson(consumerPage, historyUrl);
        expect(reloadedHistory.status).toBe(200);
        assertUnchangedHistory(resumedHistory, reloadedHistory.body);
        expect(reloadWrites).toBe(0);
      } finally {
        consumerPage.off('request', countReloadWrite);
      }
      const noTask = await readJson(
        merchantPage,
        `${originalPreview.collectionUrl}?requestId=${deniedRequestId}`,
      );
      expect(noTask).toMatchObject({ status: 200, execution: 'runnable', body: null });

      // A different, genuinely UI-created merchant exists, but this merchant
      // account cannot read the original assistant through its tenant path.
      await operatorPage.goto(`${operatorBase}/`);
      const foreignName = `运行权限负控商家 ${randomBytes(5).toString('hex')}`;
      await operatorPage.getByLabel('商家名称', { exact: true }).fill(foreignName);
      await operatorPage
        .getByRole('button', { name: '创建商家并生成领取链接', exact: true })
        .click();
      const foreignRow = operatorPage
        .locator('.ops-merchant-list li')
        .filter({ hasText: foreignName });
      await expect(foreignRow).toBeVisible();
      const foreignId = (await foreignRow.locator('small').first().textContent())!;
      expect(foreignId).toMatch(/^[a-f0-9]{32}$/u);
      const foreignRead = await merchantPage.request.get(
        originalPreview.taskUrl.replace(`/${merchantId}/`, `/${foreignId}/`),
      );
      expect(foreignRead.status()).toBe(404);
      expect(foreignRead.headers()[header]).toBeUndefined();
      await operatorPage.setViewportSize({ width: 1440, height: 1000 });
      expect(observationExposed).toBe(false);
      process.stdout.write(
        JSON.stringify({
          code: 'E2E_RUNTIME_CONTROL_VERIFIED',
          scopes: ['global', 'merchant'],
          stackedPauseChecks: 2,
          terminalJobControlDisabled: true,
          merchantOnlyJobWriteDenied: true,
          originWriteDenied: true,
          oldTaskReadable: true,
          originalSessionContinued: true,
          sameClientMessageId: true,
          observationCredentialExposed: false,
          provider: 'existing synthetic fixture',
        }) + '\n',
      );
    } finally {
      for (const context of contexts) context.off('request', inspect);
    }
  });
}
