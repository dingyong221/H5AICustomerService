import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  StagingSmokeSafetyError,
  allowedStagingRequest,
  answerForEvidence,
  checkedAcceptedTurn,
  checkedCompletedTurn,
  checkedSessionHistory,
  checkedStagingLink,
  modelExecutionBoundary,
  parseStagingImprovementOptions,
  syntheticRetailScenario,
  waitForManualDecision,
} from './staging-improvement-smoke.mjs';

const script = fileURLToPath(new URL('./staging-improvement-smoke.mjs', import.meta.url));
const origin = 'https://127.0.0.1:18443';
const challenge = `r1_${'a'.repeat(16)}`;
const environment = () => ({
  H5CS_STAGE_ORIGIN: origin,
  H5CS_STAGE_CHROME_PATH: process.execPath,
  H5CS_STAGE_OPERATOR_USERNAME: 'synthetic_operator',
  H5CS_STAGE_OPERATOR_PASSWORD: 'synthetic_password_not_a_real_credential',
  H5CS_STAGE_MODEL_MODE: 'real',
  H5CS_STAGE_SYNTHETIC_DATA_CONSENT: 'true',
});
const expectCode = (action, code) =>
  assert.throws(action, (error) => error instanceof StagingSmokeSafetyError && error.code === code);

test('requested real model never claims verified runtime provider without independent evidence', async () => {
  assert.deepEqual(modelExecutionBoundary, {
    requestedMode: 'real',
    runtimeProviderVerified: false,
    verificationRequired: 'independent_worker_configuration_and_image_evidence',
  });
  assert.equal(Object.isFrozen(modelExecutionBoundary), true);
  const smoke = await readFile(script, 'utf8');
  assert.ok(smoke.includes('modelExecution: modelExecutionBoundary'));
  assert.ok(!smoke.includes("modelMode: 'real'"));
});

test('valid explicit private HTTPS configuration is immutable and does not mutate caller env', () => {
  const source = environment();
  const copy = { ...source };
  const options = parseStagingImprovementOptions(source);
  assert.equal(options.origin, origin);
  assert.equal(options.reviewTimeoutMs, 300_000);
  assert.equal(Object.isFrozen(options), true);
  assert.deepEqual(source, copy);
  assert.equal(
    parseStagingImprovementOptions({ ...source, H5CS_STAGE_ORIGIN: 'https://[::1]:18443' }).origin,
    'https://[::1]:18443',
  );
});

test('server-confirmed completion locators match the actual create and knowledge forms', async () => {
  const create = await readFile(
    new URL('../../apps/merchant-web/app/workspace/create-assistant-form.tsx', import.meta.url),
    'utf8',
  );
  const confirm = await readFile(
    new URL('../../apps/merchant-web/app/workspace/confirm-knowledge-form.tsx', import.meta.url),
    'utf8',
  );
  const smoke = await readFile(script, 'utf8');
  assert.ok(create.includes('已创建客服草稿「{state.created.displayName}」。'));
  assert.ok(smoke.includes('已创建客服草稿「${assistantName}」。'));
  const confirmed = '当前草稿资料已确认；正式发布仍需完成对话服务与发布检查。';
  assert.ok(confirm.includes(confirmed));
  assert.ok(smoke.includes(confirmed));
  assert.ok(smoke.includes('await newConsumerPage.reload()'));
  assert.ok(smoke.includes("fail('NEW_SESSION_RESTORE_FAILED')"));
});

test('history verifies the raw flat API contract and never substitutes the client decoded model', () => {
  const sessionHandle = `s_${'a'.repeat(32)}`;
  const releaseRef = 'b'.repeat(32);
  const answer = '新疆运费尚未确认，不能套用普通地区包邮。';
  const expected = { sessionHandle, releaseRef, requiredAnswer: answer };
  const history = {
    sessionHandle,
    releaseRef,
    createdAt: '2026-10-17T01:02:03.000Z',
    snapshot: { releaseRef },
    messages: [{ role: 'assistant', content: answer }],
    activeTurn: null,
    hasEarlierMessages: false,
  };
  assert.equal(checkedSessionHistory(history, expected), history);
  for (const changed of [
    { session: { sessionHandle, releaseRef }, snapshot: history.snapshot },
    { ...history, sessionHandle: `s_${'c'.repeat(32)}` },
    { ...history, releaseRef: 'c'.repeat(32) },
    { ...history, snapshot: { releaseRef: 'c'.repeat(32) } },
    { ...history, messages: [{ role: 'visitor', content: answer }] },
    { ...history, messages: [{ role: 'assistant', content: '另一条回答' }] },
    { ...history, activeTurn: { turnId: `t_${'d'.repeat(32)}` } },
    { ...history, hasEarlierMessages: undefined },
    { ...history, extra: true },
  ])
    expectCode(() => checkedSessionHistory(changed, expected), 'UNVERIFIED_SESSION_HISTORY');
});

test('production, HTTP, aliases, noncanonical URLs and implicit ports are rejected before launch', () => {
  for (const value of [
    undefined,
    'https://h5cs.1rying.com',
    'http://127.0.0.1:18443',
    'https://localhost:18443',
    'https://127.0.0.2:18443',
    'https://0.0.0.0:18443',
    'https://127.0.0.1',
    'https://127.0.0.1:443',
    `${origin}/`,
    `${origin}/ops`,
    `${origin}?token=synthetic`,
    `${origin}#synthetic`,
    'https://operator:synthetic@127.0.0.1:18443',
    'https://2130706433:18443',
    'https://127.1:18443',
    ' https://127.0.0.1:18443',
  ])
    expectCode(
      () => parseStagingImprovementOptions({ ...environment(), H5CS_STAGE_ORIGIN: value }),
      'INVALID_PRIVATE_ORIGIN',
    );
});

test('real mode and explicit synthetic data consent are both mandatory', () => {
  for (const mode of [undefined, '', 'fake', 'test', 'REAL'])
    expectCode(
      () => parseStagingImprovementOptions({ ...environment(), H5CS_STAGE_MODEL_MODE: mode }),
      'REAL_MODEL_MODE_REQUIRED',
    );
  for (const consent of [undefined, '', 'false', 'yes', '1'])
    expectCode(
      () =>
        parseStagingImprovementOptions({
          ...environment(),
          H5CS_STAGE_SYNTHETIC_DATA_CONSENT: consent,
        }),
      'SYNTHETIC_DATA_CONSENT_REQUIRED',
    );
});

test('arguments cannot carry credentials or enable auto-approval', () => {
  for (const args of [
    ['--password', 'synthetic'],
    ['--pass'],
    ['--auto-approve'],
    ['--origin', origin],
  ])
    expectCode(() => parseStagingImprovementOptions(environment(), args), 'INVALID_ARGUMENTS');
});

test('missing or malformed credentials and relative browser path are rejected', () => {
  for (const patch of [
    { H5CS_STAGE_OPERATOR_USERNAME: '' },
    { H5CS_STAGE_OPERATOR_USERNAME: 'synthetic\noperator' },
    { H5CS_STAGE_OPERATOR_PASSWORD: undefined },
    { H5CS_STAGE_OPERATOR_PASSWORD: 'short' },
    { H5CS_STAGE_OPERATOR_PASSWORD: 'synthetic_password\u0000' },
  ])
    expectCode(
      () => parseStagingImprovementOptions({ ...environment(), ...patch }),
      'OPERATOR_CREDENTIALS_REQUIRED',
    );
  for (const path of [undefined, '', 'chrome', './chrome', 'https://127.0.0.1/chrome'])
    expectCode(
      () => parseStagingImprovementOptions({ ...environment(), H5CS_STAGE_CHROME_PATH: path }),
      'ABSOLUTE_BROWSER_PATH_REQUIRED',
    );
});

test('recording/debug and existing browser attachment switches are rejected', () => {
  for (const name of ['DEBUG', 'PWDEBUG', 'PW_TEST_CONNECT_WS_ENDPOINT', 'PLAYWRIGHT_WS_ENDPOINT'])
    expectCode(
      () => parseStagingImprovementOptions({ ...environment(), [name]: 'synthetic' }),
      'BROWSER_DEBUG_OR_ATTACH_FORBIDDEN',
    );
});

test('manual timeout is bounded, explicit and cannot be disabled', () => {
  assert.equal(
    parseStagingImprovementOptions({ ...environment(), H5CS_STAGE_REVIEW_TIMEOUT_SECONDS: '30' })
      .reviewTimeoutMs,
    30_000,
  );
  assert.equal(
    parseStagingImprovementOptions({ ...environment(), H5CS_STAGE_REVIEW_TIMEOUT_SECONDS: '900' })
      .reviewTimeoutMs,
    900_000,
  );
  for (const seconds of ['0', '1', '29', '901', '1000', '-1', 'Infinity', '30.5', '030', ''])
    expectCode(
      () =>
        parseStagingImprovementOptions({
          ...environment(),
          H5CS_STAGE_REVIEW_TIMEOUT_SECONDS: seconds,
        }),
      'INVALID_REVIEW_TIMEOUT',
    );
});

test('browser request guard blocks all other origins including stage port changes', () => {
  assert.equal(allowedStagingRequest(`${origin}/api/v1/public/assistants/synthetic`, origin), true);
  assert.equal(allowedStagingRequest(`${origin}/_next/static/synthetic.js`, origin), true);
  for (const url of [
    'https://h5cs.1rying.com/ops',
    'https://127.0.0.1:18444/ops',
    'http://127.0.0.1:18443/ops',
    'file:///etc/passwd',
    'https://synthetic@127.0.0.1:18443/ops',
    'invalid-url',
  ])
    assert.equal(allowedStagingRequest(url, origin), false);
});

test('setup and public links must use the exact private origin and known path contract', () => {
  const setup = `${origin}/console/setup#${'x'.repeat(43)}`;
  assert.equal(checkedStagingLink(setup, origin, 'setup').href, setup);
  assert.equal(
    checkedStagingLink(`${origin}/a/synthetic-assistant`, origin, 'public').pathname,
    '/a/synthetic-assistant',
  );
  for (const [url, kind] of [
    ['https://h5cs.1rying.com/console/setup#' + 'x'.repeat(43), 'setup'],
    [`${origin}/console/setup?token=synthetic`, 'setup'],
    [`${origin}/console/setup#short`, 'setup'],
    [`${origin}/a/synthetic?token=synthetic`, 'public'],
    [`${origin}/a/synthetic#secret`, 'public'],
    [`${origin}/ops`, 'public'],
    [`${origin}/a/synthetic`, 'unknown'],
  ])
    expectCode(() => checkedStagingLink(url, origin, kind), 'UNVERIFIED_STAGING_LINK');
});

const sessionHandle = `s_${'1'.repeat(32)}`;
const currentTurnId = `t_${'2'.repeat(32)}`;
const traceId = 'trace_synthetic_current_turn';
const clientMessageId = 'client_synthetic_current_message';
const expectedTurn = {
  sessionHandle,
  turnId: currentTurnId,
  traceId,
  clientMessageId,
  question: syntheticRetailScenario.question,
};
const acceptedTurn = () => ({
  state: 'accepted',
  turnId: currentTurnId,
  traceId,
  resultUrl: `/api/v1/public/sessions/${sessionHandle}/turns/${currentTurnId}`,
  eventsUrl: `/api/v1/public/sessions/${sessionHandle}/turns/${currentTurnId}/events`,
});
const completedTurn = () => ({
  state: 'completed',
  sessionHandle,
  turnId: currentTurnId,
  traceId,
  messages: [
    {
      role: 'visitor',
      content: syntheticRetailScenario.question,
      clientMessageId,
      messageId: 'visitor_synthetic_message',
      sequence: 1,
      createdAt: '2026-10-17T00:00:00Z',
    },
    {
      role: 'assistant',
      content: syntheticRetailScenario.correctedAnswer,
      messageId: 'assistant_synthetic_message',
      sequence: 2,
      createdAt: '2026-10-17T00:00:01Z',
    },
  ],
});

test('accepted turn uses canonical current session and turn endpoints only', () => {
  const checked = checkedAcceptedTurn(acceptedTurn(), sessionHandle, origin);
  assert.equal(checked.path, acceptedTurn().resultUrl);
  const absolute = acceptedTurn();
  absolute.resultUrl = `${origin}${absolute.resultUrl}`;
  absolute.eventsUrl = `${origin}${absolute.eventsUrl}`;
  assert.equal(checkedAcceptedTurn(absolute, sessionHandle, origin).turnId, currentTurnId);
  for (const patch of [
    { state: 'completed' },
    { sessionHandle },
    { resultUrl: 'https://h5cs.1rying.com/api/v1/public' },
    { resultUrl: acceptedTurn().resultUrl + '?synthetic=1' },
    { resultUrl: acceptedTurn().resultUrl.replace(sessionHandle, `s_${'9'.repeat(32)}`) },
    { eventsUrl: acceptedTurn().eventsUrl.replace(currentTurnId, `t_${'9'.repeat(32)}`) },
    { traceId: '' },
  ])
    expectCode(
      () => checkedAcceptedTurn({ ...acceptedTurn(), ...patch }, sessionHandle, origin),
      'UNVERIFIED_ACCEPTED_TURN',
    );
});

test('only the completed assistant corresponding to the original client message is read', () => {
  assert.equal(
    checkedCompletedTurn(completedTurn(), expectedTurn),
    syntheticRetailScenario.correctedAnswer,
  );
  for (const patch of [
    { state: 'processing' },
    { sessionHandle: `s_${'9'.repeat(32)}` },
    { turnId: `t_${'9'.repeat(32)}` },
    { traceId: 'trace_synthetic_other' },
    { messages: [completedTurn().messages[1], completedTurn().messages[0]] },
    { messages: [...completedTurn().messages, completedTurn().messages[1]] },
    {
      messages: [
        { ...completedTurn().messages[0], content: 'other question' },
        completedTurn().messages[1],
      ],
    },
    {
      messages: [
        { ...completedTurn().messages[0], clientMessageId: 'client_synthetic_other' },
        completedTurn().messages[1],
      ],
    },
    { messages: [completedTurn().messages[0], { ...completedTurn().messages[1], sequence: 4 }] },
  ])
    expectCode(
      () => checkedCompletedTurn({ ...completedTurn(), ...patch }, expectedTurn),
      'UNVERIFIED_COMPLETED_TURN',
    );
});

test('evidence returns actual synthetic answer but refuses known secrets, token shapes and phones', () => {
  assert.equal(answerForEvidence('  新疆单件运费15元。  '), '新疆单件运费15元。');
  for (const answer of [
    '',
    'x'.repeat(8001),
    'answer\u0000',
    'synthetic_private_password',
    'sk-' + 'x'.repeat(24),
    'github_pat_synthetic_not_real',
    'ghp_' + 'x'.repeat(30),
    'Bearer synthetic_token_not_real',
    'h5cs_visitor=synthetic_cookie_not_real',
    // Synthetic header only; retain secret scanning without storing a literal key header.
    ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' '),
    '联系电话19900001234',
  ])
    expectCode(
      () => answerForEvidence(answer, ['synthetic_private_password']),
      'ANSWER_NOT_SAFE_TO_PRINT',
    );
});

test('synthetic fixtures clearly separate ordinary region facts and Xinjiang correction', () => {
  assert.equal(Object.isFrozen(syntheticRetailScenario), true);
  assert.equal(syntheticRetailScenario.question, '新疆单件运费，满99是否包邮');
  assert.match(syntheticRetailScenario.materialsSummary, /500ml/u);
  assert.match(syntheticRetailScenario.pricingSummary, /单件89元/u);
  assert.match(syntheticRetailScenario.pricingSummary, /普通地区运费8元/u);
  assert.match(syntheticRetailScenario.pricingSummary, /普通地区商品金额满99元包邮/u);
  assert.match(syntheticRetailScenario.pricingSummary, /新疆.*未确认/u);
  assert.doesNotMatch(syntheticRetailScenario.pricingSummary, /15元/u);
  assert.equal(
    syntheticRetailScenario.correctedAnswer,
    '新疆单件运费15元，不参加满99包邮，其他数量另确认。',
  );
  assert.match(syntheticRetailScenario.humanContact, /SYNTHETIC_ORDER_HELP/u);
  assert.doesNotMatch(
    JSON.stringify(syntheticRetailScenario),
    /\b1[3-9][0-9]{9}\b|sk-[A-Za-z0-9_-]{16,}|github_pat_|https?:\/\//u,
  );
});

test('manual gate requires fresh exact challenge and handles split CRLF input', async () => {
  const input = new PassThrough();
  const pending = waitForManualDecision(input, { challenge, timeoutMs: 1000 });
  input.write('pass ');
  input.write(`${challenge}\r\n`);
  assert.equal(await pending, 'pass');
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('end'), 0);
  assert.equal(input.isPaused(), true);
});

test('abort never records pass', async () => {
  const input = new PassThrough();
  const pending = waitForManualDecision(input, { challenge, timeoutMs: 1000 });
  input.write('abort\n');
  await assert.rejects(pending, { code: 'MANUAL_ABORTED' });
});

test('EOF, empty line, generic pass, old challenge, multiple commands and overflow reject', async () => {
  for (const text of [
    '',
    '\n',
    'pass\n',
    `pass r1_${'b'.repeat(16)}\n`,
    `pass ${challenge}\npass ${challenge}\n`,
    'x'.repeat(129),
  ]) {
    const input = new PassThrough();
    const pending = waitForManualDecision(input, { challenge, timeoutMs: 1000 });
    if (text) input.write(text);
    else input.end();
    await assert.rejects(pending, (error) =>
      ['MANUAL_INPUT_ENDED', 'MANUAL_INPUT_REJECTED'].includes(error.code),
    );
  }
});

test('prebuffered approvals are not applied to later evidence', async () => {
  const input = new PassThrough();
  input.write(`pass ${challenge}\n`);
  await assert.rejects(waitForManualDecision(input, { challenge, timeoutMs: 1000 }), {
    code: 'MANUAL_PREBUFFERED_INPUT',
  });
});

test('manual wait times out without pass and cleans listeners', async () => {
  const input = new PassThrough();
  await assert.rejects(waitForManualDecision(input, { challenge, timeoutMs: 10 }), {
    code: 'MANUAL_REVIEW_TIMED_OUT',
  });
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('end'), 0);
  assert.equal(input.listenerCount('error'), 0);
});

test('manual stream errors are sanitized instead of echoing raw input or errors', async () => {
  const input = new PassThrough();
  const pending = waitForManualDecision(input, { challenge, timeoutMs: 1000 });
  input.emit('error', new Error('synthetic_secret_should_not_escape'));
  await assert.rejects(
    pending,
    (error) => error.code === 'MANUAL_INPUT_FAILED' && !error.message.includes('synthetic_secret'),
  );
});

test('main has no disk recording, persistent/user browser attach, CI spoof or retry loop', async () => {
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(
    source,
    /\.screenshot\s*\(|\.storageState\s*\(|\.tracing\.start\s*\(|launchPersistentContext\s*\(|connectOverCDP\s*\(|recordVideo\s*:|writeFile\s*\(/u,
  );
  assert.doesNotMatch(
    source,
    /process\.env\[['"]CI['"]\]\s*=|process\.env\.CI\s*=|\.cookies\s*\(/u,
  );
  assert.match(source, /serviceWorkers: 'block'/u);
  assert.match(source, /acceptDownloads: false/u);
  assert.match(source, /delete process\.env\.H5CS_STAGE_OPERATOR_PASSWORD/u);
  assert.match(source, /corrected_draft/u);
  assert.match(source, /published_consumer/u);
});

test('invalid CLI arguments are rejected offline without printing any input credential', async () => {
  const sentinel = 'synthetic_private_sentinel_should_not_be_printed';
  const child = spawn(process.execPath, [script, '--token', sentinel], {
    env: { SystemRoot: process.env.SystemRoot, H5CS_STAGE_OPERATOR_PASSWORD: sentinel },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', resolveExit);
  });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.equal(stderr.includes(sentinel), false);
  assert.deepEqual(JSON.parse(stderr), {
    type: 'stopped',
    step: 'parameter_validation',
    code: 'INVALID_ARGUMENTS',
    automaticRetry: false,
    qualityVerdict: 'not_passed',
  });
});
