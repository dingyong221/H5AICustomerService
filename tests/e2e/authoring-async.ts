import { createHash } from 'node:crypto';
import { expect, test, type Dialog, type Page } from '@playwright/test';
import {
  authoringTaskSchema,
  type AuthoringTask,
  type DraftExpandRequest,
  type DraftExpandTask,
  type PreviewReplyRequest,
  type PreviewReplyTask,
} from '../../packages/contracts/src/authoring-task';
import { browserWrite, readPersistentTask } from './knowledge-async';

type Session = {
  collectionUrl: string;
  taskUrl: string;
  csrf: string;
  input: DraftExpandRequest | PreviewReplyRequest;
  task: AuthoringTask;
};
const previews = new WeakMap<Page, Session>();
export function lastPreviewSession(page: Page): Readonly<Session> {
  const session = previews.get(page);
  if (!session) throw new Error('Runtime acceptance requires the genuine prior preview task');
  return session;
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export async function currentDraftRevision(page: Page) {
  const text = await page.getByText(/^草稿修订 \d+$/u).textContent();
  const revision = Number(text?.match(/\d+$/u)?.[0]);
  expect(Number.isSafeInteger(revision) && revision > 0).toBe(true);
  return revision;
}
const readTask = async (page: Page, url: string) =>
  authoringTaskSchema.parse(await readPersistentTask<unknown>(page, url));
async function completedTask(page: Page, session: Session) {
  let task = session.task;
  await expect
    .poll(
      async () => {
        task = await readTask(page, session.taskUrl);
        return task.state;
      },
      { timeout: 90_000, intervals: [250, 500, 1000, 3000] },
    )
    .toBe('completed');
  expect(task).toMatchObject({
    taskId: session.task.taskId,
    modelOutcome: 'succeeded',
    stale: false,
  });
  return task;
}
async function restoreSameTask(page: Page, session: Session) {
  const restored = page.waitForResponse(
    (response) => response.request().method() === 'GET' && response.url() === session.taskUrl,
  );
  const posts: string[] = [];
  const observe = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' && request.url().startsWith(session.collectionUrl))
      posts.push(new URL(request.url()).pathname);
  };
  const discard = async (dialog: Dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.accept();
  };
  page.on('request', observe);
  page.on('dialog', discard);
  try {
    await page.reload();
    const response = await restored;
    expect(response.status()).toBe(200);
    expect(authoringTaskSchema.parse(await response.json()).taskId).toBe(session.task.taskId);
    expect(posts).toEqual([]);
    return await readTask(page, session.taskUrl);
  } finally {
    page.off('request', observe);
    page.off('dialog', discard);
  }
}
async function checkRequestBoundaries(page: Page, session: Session) {
  const { collectionUrl, input, csrf, taskUrl, task } = session;
  expect((await browserWrite(page, collectionUrl, input)).status).toBe(404);
  const wrongOrigin = await page.request.post(collectionUrl, {
    headers: { Origin: 'https://foreign.invalid', 'x-h5cs-csrf': csrf },
    data: input,
  });
  expect(wrongOrigin.status()).toBe(404);
  const replay = await browserWrite(page, collectionUrl, input, csrf);
  expect(replay.status).toBe(202);
  expect(authoringTaskSchema.parse(replay.body).taskId).toBe(task.taskId);
  const changed =
    task.kind === 'draft.expand'
      ? { ...input, currentText: (input as DraftExpandRequest).currentText + ' ' }
      : { ...input, question: (input as PreviewReplyRequest).question + ' 额外问题' };
  const conflict = await browserWrite(page, collectionUrl, changed, csrf);
  expect(conflict.status).toBe(409);
  expect(conflict.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const byRequest = await readTask(page, `${collectionUrl}?requestId=${input.requestId}`);
  expect(byRequest.taskId).toBe(task.taskId);
  const opposite =
    task.kind === 'draft.expand'
      ? taskUrl.replace(/\/drafts\/([a-f0-9]{32})\/expand-tasks\//u, '/preview/$1/reply-tasks/')
      : taskUrl.replace(/\/preview\/([a-f0-9]{32})\/reply-tasks\//u, '/drafts/$1/expand-tasks/');
  expect(opposite).not.toBe(taskUrl);
  expect((await page.request.get(opposite)).status()).toBe(404);
  expect((await browserWrite(page, `${opposite}/cancel`, {}, csrf)).status).toBe(404);
  const foreign = taskUrl.replace(
    /\/(drafts|preview)\/([a-f0-9]{32})\//u,
    `/$1/${'00'.repeat(16)}/`,
  );
  expect((await page.request.get(foreign)).status()).toBe(404);
  expect((await readTask(page, taskUrl)).taskId).toBe(task.taskId);
}
async function created(
  page: Page,
  suffix: string,
  click: () => Promise<unknown>,
): Promise<Session> {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(suffix),
  );
  await click();
  const response = await pending;
  expect(response.status()).toBe(202);
  const input = response.request().postDataJSON() as Session['input'];
  const task = authoringTaskSchema.parse(await response.json());
  const csrf = response.request().headers()['x-h5cs-csrf'] ?? '';
  expect(/^[A-Za-z0-9_-]{43}$/u.test(csrf)).toBe(true); // Never print the credential.
  expect(input.requestId).toMatch(/^authoring_[a-f0-9]{32}$/u);
  expect(task.inputRevision).toBe(input.revision);
  const collectionUrl = response.url();
  const session = { collectionUrl, taskUrl: `${collectionUrl}/${task.taskId}`, input, task, csrf };
  expect((await readTask(page, session.taskUrl)).taskId).toBe(task.taskId);
  return session;
}

export async function expandDraftAsync(page: Page, assistantId: string) {
  return test.step('real writing task restores raw UTF-8 field/revision and fills only an unsaved form', async () => {
    const form = page.locator('.assistant-edit-form');
    const field = form.locator('[name="industry"]');
    const original = await field.inputValue();
    const revision = Number(await form.locator('input[name="draftRevision"]').inputValue());
    await page.getByRole('button', { name: '帮我写细分行业', exact: true }).click();
    let panel = page.getByRole('region', { name: '细分行业填写助手', exact: true });
    await panel.getByLabel('简短描述', { exact: true }).fill('家电清洗咨询');
    await panel.getByRole('checkbox', { name: /我同意将此简述/u }).check();
    const session = await created(page, `/drafts/${assistantId}/expand-tasks`, () =>
      panel.getByRole('button', { name: '生成备选文案', exact: true }).click(),
    );
    expect(session.input).toMatchObject({
      field: 'industry',
      revision,
      currentText: original,
      brief: '家电清洗咨询',
      consent: true,
    });
    expect(session.task.kind).toBe('draft.expand');
    const hash = sha256(original);
    expect((session.task as DraftExpandTask).inputFieldHash).toBe(hash);
    expect(hash).not.toBe(sha256(original + ' '));
    await checkRequestBoundaries(page, session);
    const completed = (await completedTask(page, session)) as DraftExpandTask;
    expect(completed).toMatchObject({
      field: 'industry',
      inputFieldHash: hash,
      inputRevision: revision,
      canUse: true,
    });
    expect(completed.result!.options.length).toBeGreaterThanOrEqual(2);
    expect(completed.result!.options[0]).not.toBe(original);
    await expect(panel.getByLabel(/^备选 1/u)).toHaveValue(completed.result!.options[0]!);
    const restored = (await restoreSameTask(page, session)) as DraftExpandTask;
    expect(restored).toMatchObject({
      taskId: completed.taskId,
      field: 'industry',
      inputFieldHash: hash,
      canUse: true,
    });
    panel = page.getByRole('region', { name: '细分行业填写助手', exact: true });
    await expect(field).toHaveValue(original);
    await expect(form.locator('input[name="draftRevision"]')).toHaveValue(String(revision));
    const posts: string[] = [];
    const observe = (request: import('@playwright/test').Request) => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
    };
    page.on('request', observe);
    try {
      const revalidated = page.waitForResponse(
        (response) => response.request().method() === 'GET' && response.url() === session.taskUrl,
      );
      await panel.getByRole('button', { name: '填入此字段', exact: true }).first().click();
      expect((await revalidated).status()).toBe(200);
      await expect(field).toHaveValue(completed.result!.options[0]!);
      await expect(
        page.getByRole('status').filter({ hasText: '已填入表单，尚未保存' }),
      ).toHaveCount(1);
      await expect(form.locator('input[name="draftRevision"]')).toHaveValue(String(revision));
      expect(posts).toEqual([]);
    } finally {
      page.off('request', observe);
    }
    await page.getByRole('button', { name: '保存草稿修订', exact: true }).click();
    await expect(form.locator('input[name="draftRevision"]')).toHaveValue(String(revision + 1));
    await page.reload();
    await expect(field).toHaveValue(completed.result!.options[0]!);
    const stale = (await readTask(page, session.taskUrl)) as DraftExpandTask;
    expect(stale).toMatchObject({ taskId: completed.taskId, stale: true, canUse: false });
    const staleCreate = await browserWrite(
      page,
      session.collectionUrl,
      { ...session.input, requestId: `authoring_${'f'.repeat(32)}` },
      session.csrf,
    );
    expect(staleCreate.status).toBe(409);
    expect(staleCreate.body).toMatchObject({ code: 'INPUT_CHANGED' });
    process.stdout.write(
      JSON.stringify({
        code: 'E2E_ASYNC_DRAFT_RESTORED_AND_SAVED',
        taskId: completed.taskId,
        field: completed.field,
        inputFieldHash: hash,
        inputRevision: revision,
        savedRevision: revision + 1,
      }) + '\n',
    );
  });
}

export async function previewReplyAsync(page: Page, question: string, expectedAnswer: string) {
  await test.step('real preview task restores the same governance check before human judgement', async () => {
    const revision = await currentDraftRevision(page);
    const previous = previews.get(page);
    if (previous && previous.task.inputRevision !== revision) {
      expect(await readTask(page, previous.taskUrl)).toMatchObject({
        taskId: previous.task.taskId,
        stale: true,
        canJudge: false,
      });
      process.stdout.write(
        JSON.stringify({
          code: 'E2E_ASYNC_PREVIEW_OLD_REVISION_REJECTED',
          taskId: previous.task.taskId,
          inputRevision: previous.task.inputRevision,
          currentRevision: revision,
        }) + '\n',
      );
    }
    const controls = page.getByRole('region', { name: '当前生成任务', exact: true });
    if (previous) await expect(controls).toBeVisible();
    if (previous || (await controls.count())) {
      const close = controls.getByRole('button', { name: '关闭已结束任务', exact: true });
      await expect(close).toBeEnabled();
      const dialog = page.waitForEvent('dialog');
      const clicking = close.click();
      const prompt = await dialog;
      expect(prompt.type()).toBe('confirm');
      await prompt.accept();
      await clicking;
      await expect(controls).toHaveCount(0);
    }
    await page.getByLabel('试聊问题', { exact: true }).fill(question);
    const assistantId = new URL(page.url()).pathname.split('/').at(-1)!;
    const session = await created(page, `/preview/${assistantId}/reply-tasks`, () =>
      page.getByRole('button', { name: '发送测试问题', exact: true }).click(),
    );
    expect(session.input).toMatchObject({ revision, question });
    expect(session.task.kind).toBe('preview.reply');
    await checkRequestBoundaries(page, session);
    const completed = (await completedTask(page, session)) as PreviewReplyTask;
    expect(completed).toMatchObject({ inputRevision: revision, canJudge: true });
    expect(completed.result!.answer).toContain(expectedAnswer);
    const checkId = completed.result!.checkId;
    const verdict = page.locator('.preview-verdict-form');
    await expect(verdict.locator('input[name="checkId"]')).toHaveValue(checkId);
    await expect(verdict.locator('input[name="draftRevision"]')).toHaveValue(String(revision));
    const restored = (await restoreSameTask(page, session)) as PreviewReplyTask;
    expect(restored).toMatchObject({
      taskId: completed.taskId,
      canJudge: true,
      result: { checkId },
    });
    await expect(verdict.locator('input[name="checkId"]')).toHaveValue(checkId);
    await expect(verdict.locator('input[name="draftRevision"]')).toHaveValue(String(revision));
    const answer = page.locator('.assistant-preview-answer');
    await expect(answer).toContainText(question); // Restored from the matching server governance record.
    await expect(answer).toContainText(expectedAnswer);
    await expect(
      verdict.getByRole('checkbox', { name: /我已核对本修订的真实试聊回答/u }),
    ).not.toBeChecked();
    await expect(
      page
        .getByRole('region', { name: '当前修订发布检查', exact: true })
        .getByText('等待商家判定', { exact: true }),
    ).toBeVisible();
    previews.set(page, { ...session, task: completed });
    process.stdout.write(
      JSON.stringify({
        code: 'E2E_ASYNC_PREVIEW_RESTORED',
        taskId: completed.taskId,
        checkId,
        inputRevision: revision,
        inputFactsHash: completed.inputFactsHash,
      }) + '\n',
    );
  });
}
