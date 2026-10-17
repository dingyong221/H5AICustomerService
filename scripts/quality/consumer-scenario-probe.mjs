import { randomUUID } from 'node:crypto';

// Runs synthetic questions against the user's explicitly selected published assistant.
// No model key, merchant credential or visitor cookie is printed or persisted.
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const originValue = option('--origin');
const slug = option('--slug');
const allowLoopback = args.includes('--allow-loopback');
const questionValues = args.flatMap((arg, index) =>
  arg === '--question' && args[index + 1] ? [args[index + 1]] : [],
);
let origin;
try {
  origin = new URL(originValue);
} catch {
  throw new Error('Provide --origin with a canonical HTTPS origin');
}
if (
  origin.origin !== originValue ||
  (origin.protocol !== 'https:' &&
    !(
      allowLoopback &&
      origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(origin.hostname)
    )) ||
  !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug ?? '') ||
  questionValues.length < 1 ||
  questionValues.length > 9 ||
  questionValues.some((question) => question.trim().length < 1 || question.length > 2_000)
) {
  throw new Error(
    'Require a canonical origin, public slug and 1–9 bounded synthetic --question values',
  );
}

const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value, required, optional = []) =>
  record(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => [...required, ...optional].includes(key));
const opaque = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/u.test(value);
const timestamp = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const text = (value, maximum) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value);

function acceptedTurn(data, handle) {
  if (
    !exactKeys(data, ['turnId', 'traceId', 'state', 'eventsUrl', 'resultUrl']) ||
    data.state !== 'accepted' ||
    !/^t_[0-9a-f]{32}$/u.test(data.turnId ?? '') ||
    !opaque(data.traceId)
  )
    throw new Error('Unverified accepted turn; do not resend automatically');
  const expectedPath = `/api/v1/public/sessions/${handle}/turns/${data.turnId}`;
  for (const [field, path] of [
    ['resultUrl', expectedPath],
    ['eventsUrl', `${expectedPath}/events`],
  ]) {
    let url;
    try {
      url = new URL(data[field], origin);
    } catch {
      throw new Error('Unverified accepted turn URL; do not resend automatically');
    }
    if (
      typeof data[field] !== 'string' ||
      url.origin !== origin.origin ||
      url.pathname !== path ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.href !== `${origin.origin}${path}`
    )
      throw new Error(
        'Accepted turn URL does not match this session and turn; no other turn will be read',
      );
  }
  return { ...data, path: expectedPath };
}

function verifiedTurnResult(data, expected) {
  if (
    !exactKeys(data, ['sessionHandle', 'turnId', 'traceId', 'state', 'messages'], ['error']) ||
    data.sessionHandle !== expected.sessionHandle ||
    data.turnId !== expected.turnId ||
    data.traceId !== expected.traceId ||
    !['accepted', 'processing', 'completed', 'failed'].includes(data.state) ||
    !Array.isArray(data.messages) ||
    data.messages.length < 1 ||
    data.messages.length > 2
  )
    throw new Error(
      'Result does not match the accepted session and turn; do not resend automatically',
    );
  for (const message of data.messages) {
    if (
      !exactKeys(
        message,
        ['messageId', 'sequence', 'role', 'content', 'createdAt'],
        ['clientMessageId', 'sourceLabel'],
      ) ||
      !opaque(message.messageId) ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence < 1 ||
      !timestamp(message.createdAt) ||
      !['visitor', 'assistant'].includes(message.role) ||
      !text(message.content, message.role === 'visitor' ? 2_000 : 8_000) ||
      (message.role === 'assistant' && Object.hasOwn(message, 'clientMessageId')) ||
      (message.role === 'visitor' && Object.hasOwn(message, 'sourceLabel')) ||
      (Object.hasOwn(message, 'sourceLabel') && !text(message.sourceLabel, 80))
    )
      throw new Error('Turn contains invalid messages; no answer will be selected');
  }
  const visitor = data.messages[0];
  if (
    visitor.role !== 'visitor' ||
    visitor.clientMessageId !== expected.clientMessageId ||
    visitor.content !== expected.content
  )
    throw new Error(
      'Turn visitor message does not match the submitted client message; no answer will be selected',
    );
  if (data.state === 'failed') {
    if (
      !exactKeys(data.error, ['code', 'retryable']) ||
      !opaque(data.error.code) ||
      typeof data.error.retryable !== 'boolean' ||
      data.messages.length !== 1
    )
      throw new Error('Invalid failed turn result');
    return data;
  }
  if (Object.hasOwn(data, 'error')) throw new Error('Unexpected turn error metadata');
  if (data.state === 'completed') {
    const assistant = data.messages[1];
    if (
      data.messages.length !== 2 ||
      assistant?.role !== 'assistant' ||
      assistant.sequence !== visitor.sequence + 1 ||
      assistant.messageId === visitor.messageId
    )
      throw new Error('Completed turn has no corresponding assistant answer');
  } else if (data.messages.length !== 1)
    throw new Error('Non-terminal turn contains an unexpected assistant answer');
  return data;
}

let cookie = '';
const request = async (path, { method = 'GET', body, key, expectedStatus = 200 } = {}) => {
  const response = await fetch(new URL(path, origin), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/json',
      Origin: origin.origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const value of response.headers.getSetCookie()) {
    if (/^(?:__Host-)?h5cs_visitor=/u.test(value)) cookie = value.split(';')[0];
  }
  if (
    response.status !== expectedStatus ||
    !response.headers.get('content-type')?.includes('application/json')
  ) {
    throw new Error(`Scenario endpoint failed with HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Scenario endpoint returned invalid JSON');
  }
  if (
    !exactKeys(payload, ['data', 'request_id']) ||
    !record(payload.data) ||
    !opaque(payload.request_id)
  ) {
    throw new Error('Scenario endpoint returned an invalid envelope');
  }
  return payload.data;
};

let sessionHandle;
try {
  const snapshot = await request(`/api/v1/public/assistants/${slug}`);
  if (
    snapshot.publicAssistantId !== slug ||
    snapshot.availability !== 'online' ||
    !/^[0-9a-f]{32}$/u.test(snapshot.releaseRef ?? '')
  )
    throw new Error('Published assistant identity was not verified');
  const session = await request(`/api/v1/public/assistants/${slug}/sessions`, {
    method: 'POST',
    key: `session_request_${randomUUID().replaceAll('-', '')}`,
    expectedStatus: 201,
  });
  if (
    !/^s_[0-9a-f]{32}$/u.test(session.sessionHandle ?? '') ||
    session.releaseRef !== snapshot.releaseRef ||
    session.state !== 'active' ||
    !timestamp(session.createdAt)
  ) {
    throw new Error('Could not verify the session and published revision');
  }
  sessionHandle = session.sessionHandle;
  process.stdout.write(
    `${JSON.stringify({ type: 'start', checkedAt: new Date().toISOString(), releaseRef: snapshot.releaseRef, synthetic: true, qualityVerdict: 'requires_human_review' })}\n`,
  );
  const seenTurns = new Set();
  for (const rawQuestion of questionValues) {
    const question = rawQuestion.trim();
    const clientMessageId = `message_${randomUUID().replaceAll('-', '')}`;
    const accepted = acceptedTurn(
      await request(`/api/v1/public/sessions/${sessionHandle}/messages`, {
        method: 'POST',
        key: clientMessageId,
        body: { clientMessageId, content: question },
        expectedStatus: 202,
      }),
      sessionHandle,
    );
    if (seenTurns.has(accepted.turnId))
      throw new Error(
        'Accepted turn was reused for another client message; no other turn will be read',
      );
    seenTurns.add(accepted.turnId);
    const deadline = Date.now() + 90_000;
    let terminal = false;
    while (Date.now() < deadline) {
      const result = verifiedTurnResult(await request(accepted.path), {
        sessionHandle,
        turnId: accepted.turnId,
        traceId: accepted.traceId,
        clientMessageId,
        content: question,
      });
      if (result.state === 'failed')
        throw new Error('The model turn failed; no quality pass recorded');
      if (result.state === 'completed') {
        const answer = result.messages[1].content;
        if (typeof answer !== 'string' || !answer.trim()) throw new Error('No persisted answer');
        process.stdout.write(
          `${JSON.stringify({ type: 'answer', question, answer, technicalState: 'completed', qualityVerdict: 'requires_human_review' })}\n`,
        );
        terminal = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!terminal)
      throw new Error('Timed out observing the same turn; do not resend automatically');
  }
} finally {
  if (sessionHandle) {
    try {
      const ended = await request(`/api/v1/public/sessions/${sessionHandle}/end`, {
        method: 'POST',
      });
      if (ended.sessionHandle !== sessionHandle || ended.state !== 'ended')
        throw new Error('Session end confirmation did not match');
      process.stdout.write(`${JSON.stringify({ type: 'end', state: 'ended' })}\n`);
    } catch {
      process.stderr.write('Session end was not confirmed; no automatic resend was attempted.\n');
      process.exitCode = 1;
    }
  }
  cookie = '';
}
