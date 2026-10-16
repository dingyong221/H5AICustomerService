import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./consumer-scenario-probe.mjs', import.meta.url));
const sessionHandle = `s_${'1'.repeat(32)}`;
const turnId = `t_${'2'.repeat(32)}`;
const releaseRef = '3'.repeat(32);

const runProbe = async (origin, questions) => {
  const child = spawn(
    process.execPath,
    [
      script,
      '--allow-loopback',
      '--origin',
      origin,
      '--slug',
      'test-assistant',
      ...questions.flatMap((q) => ['--question', q]),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, stderr };
};

async function fakeApi(callback, options = {}) {
  const calls = [];
  let active;
  let messageCount = 0;
  let pollCount = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const content = Buffer.concat(chunks).toString('utf8');
    calls.push({
      method: request.method,
      path: request.url,
      content,
      cookie: request.headers.cookie,
      idempotencyKey: request.headers['idempotency-key'],
    });
    response.setHeader('Content-Type', 'application/json');
    let data;
    if (request.url.endsWith('/sessions') && request.method === 'POST') {
      response.statusCode = 201;
      response.setHeader(
        'Set-Cookie',
        'h5cs_visitor=synthetic-cookie-that-must-not-be-logged; HttpOnly; Path=/',
      );
      data = { sessionHandle, releaseRef, state: 'active', createdAt: '2026-10-17T00:00:00.000Z' };
    } else if (request.url.endsWith('/messages')) {
      response.statusCode = 202;
      messageCount += 1;
      pollCount = 0;
      const submitted = JSON.parse(content);
      const currentTurnId = options.reuseTurn
        ? turnId
        : `t_${(messageCount + 1).toString(16).repeat(32)}`;
      active = {
        turnId: currentTurnId,
        traceId: `trace_${currentTurnId.slice(2)}`,
        clientMessageId: submitted.clientMessageId,
        content: submitted.content,
        sequence: messageCount * 2 - 1,
      };
      const resultUrl = `http://${request.headers.host}/api/v1/public/sessions/${sessionHandle}/turns/${currentTurnId}`;
      data = {
        turnId: currentTurnId,
        traceId: active.traceId,
        state: 'accepted',
        resultUrl,
        eventsUrl: `${resultUrl}/events`,
      };
      if (options.accepted) data = options.accepted(data, { active, calls });
    } else if (request.url === `/api/v1/public/sessions/${sessionHandle}/turns/${active?.turnId}`) {
      const state =
        options.states?.[pollCount] ??
        options.states?.at(-1) ??
        options.terminalState ??
        'completed';
      pollCount += 1;
      data = {
        sessionHandle,
        turnId: active.turnId,
        traceId: active.traceId,
        state,
        messages: [
          {
            messageId: `visitor_${messageCount.toString(16).padStart(32, '0')}`,
            sequence: active.sequence,
            role: 'visitor',
            clientMessageId: active.clientMessageId,
            content: active.content,
            createdAt: '2026-10-17T00:00:00.000Z',
          },
          ...(state === 'completed'
            ? [
                {
                  messageId: `assistant_${messageCount.toString(16).padStart(32, '0')}`,
                  sequence: active.sequence + 1,
                  role: 'assistant',
                  content: '这是测试答案，不是实际质量通过。',
                  createdAt: '2026-10-17T00:00:01.000Z',
                },
              ]
            : []),
        ],
        ...(state === 'failed' ? { error: { code: 'MODEL_UNAVAILABLE', retryable: false } } : {}),
      };
      if (options.result) data = options.result(data, { active, calls, pollCount });
      if (options.resultStatus) response.statusCode = options.resultStatus;
    } else if (request.url.endsWith('/end')) {
      data = { sessionHandle, state: 'ended' };
      if (options.end) data = options.end(data);
    } else {
      data = { publicAssistantId: 'test-assistant', availability: 'online', releaseRef };
    }
    response.end(JSON.stringify({ data, request_id: 'synthetic-request' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('accepts real t_ turn references, observes once and never logs the visitor credential', async () => {
  await fakeApi(async (origin, calls) => {
    const result = await runProbe(origin, ['缺价格时如何回答？', '怎样联系人工？']);
    assert.equal(result.code, 0, result.stderr);
    const output = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(output.filter((line) => line.type === 'answer').length, 2);
    assert.ok(
      output
        .filter((line) => line.type === 'answer')
        .every((line) => line.qualityVerdict === 'requires_human_review'),
    );
    assert.equal(output.at(-1).state, 'ended');
    assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 2);
    assert.ok(
      calls
        .filter((call) => call.path.endsWith('/messages'))
        .every((call) => JSON.parse(call.content).clientMessageId === call.idempotencyKey),
    );
    assert.deepEqual(
      calls.filter((call) => call.path.includes('/turns/')).map((call) => call.path),
      [
        `/api/v1/public/sessions/${sessionHandle}/turns/${turnId}`,
        `/api/v1/public/sessions/${sessionHandle}/turns/t_${'3'.repeat(32)}`,
      ],
    );
    assert.ok(
      calls
        .filter((call) => call.path.endsWith('/messages'))
        .every((call) => call.cookie?.includes('synthetic-cookie')),
    );
    assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-cookie'));
  });
});

test('an uncertain accepted result is not automatically sent again', async () => {
  await fakeApi(
    async (origin, calls) => {
      const result = await runProbe(origin, ['原问题']);
      assert.notEqual(result.code, 0);
      assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 1);
      assert.equal(calls.filter((call) => call.path.endsWith('/end')).length, 1);
      assert.ok(!result.stdout.includes('"type":"answer"'));
    },
    { accepted: (data) => ({ ...data, turnId: 'unexpected-reference' }) },
  );
});

test('a failed model turn never receives a quality pass or answer success', async () => {
  await fakeApi(
    async (origin, calls) => {
      const result = await runProbe(origin, ['原问题']);
      assert.notEqual(result.code, 0);
      assert.ok(!result.stdout.includes('"type":"answer"'));
      assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 1);
    },
    { terminalState: 'failed' },
  );
});

test('rejects an origin with a path before transmitting a question', async () => {
  await fakeApi(async (origin, calls) => {
    const result = await runProbe(`${origin}/not-an-origin`, ['原问题']);
    assert.notEqual(result.code, 0);
    assert.equal(calls.length, 0);
  });
});

for (const [name, accepted] of [
  [
    'another session result URL',
    (data) => ({
      ...data,
      resultUrl: data.resultUrl.replace(sessionHandle, `s_${'9'.repeat(32)}`),
    }),
  ],
  [
    'another turn events URL',
    (data) => ({ ...data, eventsUrl: data.eventsUrl.replace(turnId, `t_${'9'.repeat(32)}`) }),
  ],
  [
    'cross-origin result URL',
    (data) => ({
      ...data,
      resultUrl: data.resultUrl.replace(/^http:\/\/[^/]+/u, 'https://foreign.example'),
    }),
  ],
  ['unconfirmed acceptance state', (data) => ({ ...data, state: 'processing' })],
]) {
  test(`rejects accepted ${name} before reading any turn or resending`, async () => {
    await fakeApi(
      async (origin, calls) => {
        const result = await runProbe(origin, ['原问题']);
        assert.notEqual(result.code, 0);
        assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 1);
        assert.equal(calls.filter((call) => call.path.includes('/turns/')).length, 0);
        assert.ok(!result.stdout.includes('"type":"answer"'));
      },
      { accepted },
    );
  });
}

for (const [name, resultMutation] of [
  ['foreign session', (data) => ({ ...data, sessionHandle: `s_${'9'.repeat(32)}` })],
  ['foreign turn', (data) => ({ ...data, turnId: `t_${'9'.repeat(32)}` })],
  ['foreign trace', (data) => ({ ...data, traceId: `trace_${'9'.repeat(32)}` })],
  [
    'another client message',
    (data) => ({
      ...data,
      messages: [
        { ...data.messages[0], clientMessageId: `message_${'9'.repeat(32)}` },
        data.messages[1],
      ],
    }),
  ],
  [
    'another submitted question',
    (data) => ({
      ...data,
      messages: [{ ...data.messages[0], content: '不是本次提交的问题' }, data.messages[1]],
    }),
  ],
  ['assistant without its visitor', (data) => ({ ...data, messages: [data.messages[1]] })],
  [
    'mixed-turn history instead of turn-scoped messages',
    (data) => ({
      ...data,
      messages: [
        {
          ...data.messages[1],
          messageId: 'foreign_assistant_message',
          sequence: 1,
          content: '其他turn的答案，不得读取',
        },
        ...data.messages,
      ],
    }),
  ],
  [
    'out-of-order assistant',
    (data) => ({
      ...data,
      messages: [
        data.messages[0],
        { ...data.messages[1], sequence: data.messages[0].sequence - 1 },
      ],
    }),
  ],
  ['completed state without an assistant', (data) => ({ ...data, messages: [data.messages[0]] })],
]) {
  test(`rejects result with ${name}, never selects a foreign answer and never resends`, async () => {
    await fakeApi(
      async (origin, calls) => {
        const result = await runProbe(origin, ['原问题']);
        assert.notEqual(result.code, 0);
        assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 1);
        assert.deepEqual(
          calls.filter((call) => call.path.includes('/turns/')).map((call) => call.path),
          [`/api/v1/public/sessions/${sessionHandle}/turns/${turnId}`],
        );
        assert.ok(!result.stdout.includes('"type":"answer"'));
        assert.ok(!`${result.stdout}${result.stderr}`.includes('其他turn的答案'));
      },
      { result: resultMutation },
    );
  });
}

test('observes processing then completion only on the originally accepted turn', async () => {
  await fakeApi(
    async (origin, calls) => {
      const result = await runProbe(origin, ['原问题']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 1);
      assert.deepEqual(
        calls.filter((call) => call.path.includes('/turns/')).map((call) => call.path),
        Array(2).fill(`/api/v1/public/sessions/${sessionHandle}/turns/${turnId}`),
      );
      assert.equal(
        result.stdout.split('\n').filter((line) => line.includes('"type":"answer"')).length,
        1,
      );
    },
    { states: ['processing', 'completed'] },
  );
});

test('an unavailable result does not create another message or switch to another turn', async () => {
  await fakeApi(
    async (origin, calls) => {
      const result = await runProbe(origin, ['原问题']);
      assert.notEqual(result.code, 0);
      assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 1);
      assert.deepEqual(
        calls.filter((call) => call.path.includes('/turns/')).map((call) => call.path),
        [`/api/v1/public/sessions/${sessionHandle}/turns/${turnId}`],
      );
      assert.ok(!result.stdout.includes('"type":"answer"'));
    },
    { resultStatus: 503 },
  );
});

test('a new message must not reuse the preceding message turn even with forged matching content', async () => {
  await fakeApi(
    async (origin, calls) => {
      const result = await runProbe(origin, ['第一个问题', '第二个问题']);
      assert.notEqual(result.code, 0);
      assert.equal(calls.filter((call) => call.path.endsWith('/messages')).length, 2);
      assert.equal(calls.filter((call) => call.path.includes('/turns/')).length, 1);
      assert.equal(
        result.stdout.split('\n').filter((line) => line.includes('"type":"answer"')).length,
        1,
      );
    },
    { reuseTurn: true },
  );
});

test('never reports an ended session when the confirmation refers to another session', async () => {
  await fakeApi(
    async (origin) => {
      const result = await runProbe(origin, ['原问题']);
      assert.notEqual(result.code, 0);
      assert.ok(!result.stdout.includes('"type":"end"'));
      assert.match(result.stderr, /end was not confirmed/u);
    },
    { end: (data) => ({ ...data, sessionHandle: `s_${'9'.repeat(32)}` }) },
  );
});
