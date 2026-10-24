import { createServer } from 'node:http';

const key = process.env.H5CS_E2E_MODEL_KEY;
const database = new URL(process.env.H5CS_INTEGRATION_MYSQL_URL ?? 'invalid:');
if (
  process.env.NODE_ENV !== 'test' ||
  !key?.startsWith('local-fixture-') ||
  database.protocol !== 'mysql:' ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  database.pathname !== '/h5cs_integration_ci'
)
  throw new Error('This deterministic model is restricted to the dedicated local test database');
let calls = 0;
const maximum = 80;
createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ localFixture: true, calls, maximum }));
    return;
  }
  if (
    request.method !== 'POST' ||
    request.url !== '/chat/completions' ||
    request.headers.authorization !== `Bearer ${key}`
  ) {
    response.writeHead(404).end();
    return;
  }
  if (calls >= maximum) {
    response.writeHead(429).end();
    return;
  }
  calls++;
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 100_000) throw new Error();
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = JSON.stringify(payload.messages);
    const facts = payload.messages?.[1]?.content ?? '';
    let content;
    if (messages.includes('商家知识资料整理助手')) {
      const units = JSON.parse(facts.split('\n')[1]).units;
      content = JSON.stringify({
        groups: [{ topic: '商品/服务', unitIds: units.map((unit) => unit.id) }],
        reviewUnitIds: [],
      });
    } else {
      content =
        '本地模型测试回复：提供上门空调清洗服务；' +
        (facts.includes('预约需提前1天') ? '预约需提前1天；' : '') +
        (facts.includes('也提供洗衣机清洁咨询') ? '也提供洗衣机清洁咨询；' : '') +
        (facts.includes('89元')
          ? '价格：89元；'
          : facts.includes('79元')
            ? '价格：79元；'
            : '具体价格请联系商家确认；') +
        '不提供安装服务。';
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        object: 'chat.completion',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      }),
    );
  } catch {
    response.writeHead(400).end();
  }
}).listen(9020, '127.0.0.1');
