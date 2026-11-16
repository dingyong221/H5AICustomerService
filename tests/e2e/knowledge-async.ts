import { expect, test, type Dialog, type Locator, type Page } from '@playwright/test';
import type {
  KnowledgeOrganizationRequest,
  KnowledgeOrganizationTask,
} from '../../packages/contracts/src/knowledge-organization';

export type AsyncKnowledgeSession = {
  collectionUrl: string;
  taskUrl: string;
  input: KnowledgeOrganizationRequest;
  task: KnowledgeOrganizationTask;
  csrf: string;
};

// Fetch from the actual authenticated Next page: Cookie/Origin come from the
// browser. No route interception, mocked session or direct repository write.
export async function browserWrite(page: Page, url: string, body: unknown, csrf?: string) {
  return page.evaluate(
    async ({ url, body, csrf }) => {
      const response = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-h5cs-csrf': csrf } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    { url, body, csrf },
  );
}

export async function readPersistentTask<T = KnowledgeOrganizationTask>(page: Page, url: string) {
  const request = page.waitForRequest(
    (request) => request.method() === 'GET' && request.url() === url,
  );
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
    return { status: response.status, task: (await response.json()) as T };
  }, url);
  const observed = await request;
  expect(observed.headers()).not.toHaveProperty('origin');
  expect(observed.headers()).not.toHaveProperty('x-h5cs-csrf');
  expect(result.status).toBe(200);
  return result.task;
}
const readTask = (page: Page, url: string) =>
  readPersistentTask<KnowledgeOrganizationTask>(page, url);

export async function organizeKnowledgeAsync(
  page: Page,
  panel: Locator,
  assistantId: string,
  deletedSourceId: string,
): Promise<AsyncKnowledgeSession> {
  return test.step('real Next session enqueues, reads and restores the same knowledge task', async () => {
    const collectionSuffix = `/knowledge/${assistantId}/materials/organize-tasks`;
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).origin === new URL(page.url()).origin &&
        new URL(response.url()).pathname.endsWith(collectionSuffix),
    );
    await panel.getByRole('button', { name: 'AI 整理所选材料', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    const collectionUrl = response.url();
    const input = response.request().postDataJSON() as KnowledgeOrganizationRequest;
    const task = (await response.json()) as KnowledgeOrganizationTask;
    const csrf = response.request().headers()['x-h5cs-csrf'] ?? '';
    // Validate the synthetic credential without printing it on assertion failure.
    expect(/^[A-Za-z0-9_-]{43}$/u.test(csrf)).toBe(true);
    expect(input.requestId).toMatch(/^organize_[a-f0-9]{32}$/u);
    expect(input.consent).toBe(true);
    expect(input.sourceIds).toHaveLength(1);
    expect(input.sourceIds).not.toContain(deletedSourceId);
    expect(task.taskId).toMatch(/^[a-f0-9]{32}$/u);
    expect(task.inputRevision).toBe(input.revision);
    expect(task.sources.map((source) => source.id)).toEqual(input.sourceIds);
    expect(['queued', 'processing', 'completed']).toContain(task.state);
    const taskUrl = `${collectionUrl}/${task.taskId}`;
    expect((await readTask(page, taskUrl)).taskId).toBe(task.taskId);

    const missingCsrf = await browserWrite(page, collectionUrl, input);
    expect(missingCsrf.status).toBe(404);
    const badOrigin = await page.request.post(collectionUrl, {
      headers: { Origin: 'https://foreign.invalid', 'x-h5cs-csrf': csrf },
      data: input,
    });
    expect(badOrigin.status()).toBe(404);
    const foreign = await page.request.get(
      taskUrl.replace(`/knowledge/${assistantId}/`, `/knowledge/${'00'.repeat(16)}/`),
    );
    expect(foreign.status()).toBe(404);

    const replay = await browserWrite(page, collectionUrl, input, csrf);
    expect(replay.status).toBe(202);
    expect((replay.body as KnowledgeOrganizationTask).taskId).toBe(task.taskId);
    const conflict = await browserWrite(
      page,
      collectionUrl,
      { ...input, revision: input.revision + 1 },
      csrf,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const byRequest = await page.request.get(`${collectionUrl}?requestId=${input.requestId}`);
    expect(byRequest.status()).toBe(200);
    expect(((await byRequest.json()) as KnowledgeOrganizationTask).taskId).toBe(task.taskId);

    // Complete before reloading so the existing unsaved-candidate prompt is
    // deterministic. A reload must recover a persisted completed result, not POST.
    await expect(panel.getByLabel('知识整理稿', { exact: true })).toHaveValue(/预约需提前1天/u, {
      timeout: 90_000,
    });
    await expect(panel.getByRole('checkbox', { name: /我已核对整理稿/u })).not.toBeChecked();
    const completed = await readTask(page, taskUrl);
    expect(completed).toMatchObject({
      taskId: task.taskId,
      state: 'completed',
      modelOutcome: 'succeeded',
      canApply: true,
      stale: false,
    });
    expect(completed.result?.summary).toContain('预约需提前1天');
    const afterReload = page.waitForResponse(
      (response) => response.request().method() === 'GET' && response.url() === taskUrl,
    );
    const postRequests: string[] = [];
    const observe = (request: import('@playwright/test').Request) => {
      if (
        request.method() === 'POST' &&
        request.url().includes(`/knowledge/${assistantId}/materials/`)
      )
        postRequests.push(new URL(request.url()).pathname);
    };
    let dialogType: string | undefined;
    const discardCandidate = async (dialog: Dialog) => {
      dialogType = dialog.type();
      await dialog.accept();
    };
    page.on('request', observe);
    page.on('dialog', discardCandidate);
    try {
      await page.reload();
      const restoredResponse = await afterReload;
      expect(restoredResponse.status()).toBe(200);
      expect(((await restoredResponse.json()) as KnowledgeOrganizationTask).taskId).toBe(
        task.taskId,
      );
      await expect(panel.getByLabel('知识整理稿', { exact: true })).toHaveValue(
        completed.result!.summary,
      );
      await expect(panel.getByRole('checkbox', { name: /我已核对整理稿/u })).not.toBeChecked();
      expect(postRequests).toEqual([]);
      expect(dialogType === undefined || dialogType === 'beforeunload').toBe(true);
    } finally {
      page.off('request', observe);
      page.off('dialog', discardCandidate);
    }
    process.stdout.write(
      JSON.stringify({
        code: 'E2E_ASYNC_KNOWLEDGE_RESTORED',
        taskId: task.taskId,
        inputRevision: input.revision,
        state: completed.state,
      }) + '\n',
    );
    return { collectionUrl, taskUrl, input, task: completed, csrf };
  });
}

export async function applyKnowledgeAsync(
  page: Page,
  panel: Locator,
  session: AsyncKnowledgeSession,
) {
  await test.step('human adoption uses task revision CAS and replays its persisted receipt', async () => {
    const applyUrl = `${session.taskUrl}/apply`;
    await expect(
      panel.getByRole('button', { name: '保存整理稿到客服草稿', exact: true }),
    ).toBeDisabled();
    const summary = `${session.task.result!.summary}\n预约细节请向商家确认。`;
    await panel.getByLabel('知识整理稿', { exact: true }).fill(summary);
    const body = { revision: session.input.revision, summary, mode: 'append', confirmed: true };
    expect((await browserWrite(page, applyUrl, body)).status).toBe(404);
    expect(
      (await browserWrite(page, applyUrl, { ...body, confirmed: false }, session.csrf)).status,
    ).toBe(400);
    const stale = await browserWrite(
      page,
      applyUrl,
      { ...body, revision: body.revision + 1 },
      session.csrf,
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'INPUT_CHANGED' });
    const unchanged = await readTask(page, session.taskUrl);
    expect(unchanged).toMatchObject({ canApply: true, stale: false });
    expect(unchanged.appliedRevision).toBeUndefined();
    await panel.getByRole('checkbox', { name: /我已核对整理稿/u }).check();
    const appliedResponse = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url() === applyUrl,
    );
    await panel.getByRole('button', { name: '保存整理稿到客服草稿', exact: true }).click();
    const applied = await appliedResponse;
    expect(applied.status()).toBe(200);
    expect(applied.request().postDataJSON()).toEqual(body);
    const receipt = (await applied.json()) as { saved: boolean; revision: number };
    expect(receipt).toEqual({ saved: true, revision: body.revision + 1 });
    await expect(panel.getByRole('status').filter({ hasText: '知识已保存到草稿' })).toHaveCount(1);
    await expect(page.getByText(/^草稿修订 \d+$/u)).toHaveText(`草稿修订 ${receipt.revision}`);
    const replay = await browserWrite(page, applyUrl, body, session.csrf);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(receipt);
    const changed = await browserWrite(page, applyUrl, { ...body, mode: 'replace' }, session.csrf);
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const readback = await readTask(page, session.taskUrl);
    expect(readback).toMatchObject({
      taskId: session.task.taskId,
      appliedRevision: receipt.revision,
      canApply: false,
    });
    const byRequest = await page.request.get(
      `${session.collectionUrl}?requestId=${session.input.requestId}`,
    );
    expect(byRequest.status()).toBe(200);
    expect(await byRequest.json()).toMatchObject({
      taskId: session.task.taskId,
      appliedRevision: receipt.revision,
    });
    process.stdout.write(
      JSON.stringify({
        code: 'E2E_ASYNC_KNOWLEDGE_APPLIED',
        taskId: session.task.taskId,
        inputRevision: body.revision,
        appliedRevision: receipt.revision,
      }) + '\n',
    );
  });
}
