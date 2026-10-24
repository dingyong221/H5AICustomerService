import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/merchant-web/package.json', import.meta.url));
const ts = require('typescript');
const evidence = resolve(root, 'artifacts/business-ux-governance-20261024/integration');
await mkdir(evidence, { recursive: true });
const code = ts.transpileModule(
  await readFile(resolve(root, 'apps/merchant-web/app/workspace/unsaved-history-guard.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>仅本地：未保存导航回归</title><body>
<h1>仅本地合成输入，不连接业务库或模型</h1><div id="app"></div>
<script type="module">
import { installUnsavedHistoryGuard, registerUnsavedNavigationGuard } from '/guard.mjs';
let dirty=false, renders=0;
installUnsavedHistoryGuard(window, 'isolated-browser-regression');
registerUnsavedNavigationGuard(()=>dirty);
function render(){ renders++; dirty=false; document.querySelector('#app').innerHTML='<h2>'+location.pathname+'</h2><label>资料<textarea id="memo"></textarea></label><button id="save">保存</button><a href="/edit">编辑</a> <a href="/knowledge">知识</a> <a href="/preview">试聊</a>'; document.querySelector('#memo').oninput=()=>{dirty=true}; document.querySelector('#save').onclick=()=>{dirty=false}; document.body.dataset.renders=String(renders); }
addEventListener('popstate',render);
addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue=''}});
document.addEventListener('click',event=>{const link=event.target.closest('a');if(!link)return;event.preventDefault();history.pushState({__NA:true,tree:['test-router']},'',link.href);render()});
render(); document.body.dataset.ready='true';
</script></body></html>`;
const server = createServer((request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-type',
    request.url === '/guard.mjs' ? 'text/javascript' : 'text/html; charset=utf-8',
  );
  response.end(request.url === '/guard.mjs' ? code : html);
});
await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable');
let executablePath;
for (const candidate of [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
});
const results = [];
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      hasTouch: mobile,
      isMobile: mobile,
    });
    const page = await context.newPage();
    const answers = [];
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (answers.shift() === true) await dialog.accept();
      else await dialog.dismiss();
    });
    const base = 'http://127.0.0.1:' + address.port;
    await page.goto(base);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('link', { name: '编辑', exact: true }).click();
    await page.locator('#memo').fill('本地合成：未保存商品条件');
    const length = await page.evaluate(() => history.length);
    const renders = await page.locator('body').getAttribute('data-renders');
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = dialogs.length;
      answers.push(false);
      await page.evaluate(() => history.back());
      await expect.poll(() => dialogs.length).toBe(previous + 1);
      await expect(page).toHaveURL(base + '/edit');
      await expect(page.locator('#memo')).toHaveValue('本地合成：未保存商品条件');
      await expect(page.locator('body')).toHaveAttribute('data-renders', renders);
    }
    expect(await page.evaluate(() => history.length)).toBe(length);
    answers.push(true);
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(base + '/');
    await expect(page.locator('h2')).toHaveText('/');

    // Forward is protected too; cancelled navigation returns to exactly this entry.
    await page.locator('#memo').fill('本地合成：前进前未保存');
    const beforeForward = dialogs.length;
    answers.push(false);
    await page.evaluate(() => history.forward());
    await expect.poll(() => dialogs.length).toBe(beforeForward + 1);
    await expect(page).toHaveURL(base + '/');
    await expect(page.locator('#memo')).toHaveValue('本地合成：前进前未保存');
    answers.push(true);
    await page.evaluate(() => history.forward());
    await expect(page).toHaveURL(base + '/edit');
    await expect(page.locator('h2')).toHaveText('/edit');

    // Confirmed save removes the guard immediately, without duplicate history entries.
    await page.locator('#memo').fill('本地合成：已保存');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const afterSaveDialogs = dialogs.length;
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(base + '/');
    expect(dialogs.length).toBe(afterSaveDialogs);

    for (const name of ['编辑', '知识', '试聊'])
      await page.getByRole('link', { name, exact: true }).click();
    await page.locator('#memo').fill('本地合成：跨三步返回');
    const multiLength = await page.evaluate(() => history.length);
    const beforeMulti = dialogs.length;
    answers.push(false);
    await page.evaluate(() => history.go(-3));
    await expect.poll(() => dialogs.length).toBe(beforeMulti + 1);
    await expect(page).toHaveURL(base + '/preview');
    await expect(page.locator('#memo')).toHaveValue('本地合成：跨三步返回');
    expect(await page.evaluate(() => history.length)).toBe(multiLength);

    // Native reload protection is still present; no merchant text is stored in history.
    const beforeReload = dialogs.length;
    answers.push(false);
    await page.evaluate(() => location.reload());
    await expect.poll(() => dialogs.length).toBe(beforeReload + 1);
    expect(dialogs.at(-1).type).toBe('beforeunload');
    await expect(page.locator('#memo')).toHaveValue('本地合成：跨三步返回');
    const state = await page.evaluate(() => JSON.stringify(history.state));
    expect(state).not.toContain('本地合成');
    await page.screenshot({
      path: resolve(evidence, `unsaved-${mobile ? 'mobile' : 'desktop'}.png`),
    });
    results.push({
      device: mobile ? 'mobile-touch-emulation' : 'desktop',
      cancelledBackTwice: true,
      confirmedBack: true,
      forwardCancelAndAccept: true,
      cleanSaveBackWithoutPrompt: true,
      multiStepBackCancel: true,
      reloadCancelPreservesInput: true,
      extraHistoryEntries: 0,
      businessTextInHistory: false,
    });
    await context.close();
  }
  await writeFile(
    resolve(evidence, 'unsaved-browser-result.json'),
    JSON.stringify(
      {
        kind: 'real-browser-history-regression',
        result: 'passed',
        fixture: 'isolated DOM router; actual merchant integration separately required',
        paidSupplierCalls: 0,
        productionTouched: false,
        cases: results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(JSON.stringify({ result: 'passed', devices: results.length }) + '\n');
} finally {
  await browser.close();
  await new Promise((resolveClosed) => server.close(resolveClosed));
}
