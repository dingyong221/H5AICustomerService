import { createServer } from 'node:http';

const key = process.env.H5CS_E2E_MODEL_KEY;
if (!key || process.env.H5CS_INTEGRATION_MYSQL_URL === undefined) {
  throw new Error('The local browser-test model requires isolated test configuration');
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ready' }));
    return;
  }
  if (
    request.method !== 'POST' ||
    request.url !== '/chat/completions' ||
    request.headers.authorization !== `Bearer ${key}`
  ) {
    response.writeHead(404);
    response.end();
    return;
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64_000) throw new Error('Request exceeds browser-test limit');
      chunks.push(chunk);
    }
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const messages = JSON.stringify(payload.messages);
  const organizing = messages.includes('商家知识资料整理助手');
  const content = organizing
    ? JSON.stringify({
        summary:
          '服务说明：提供上门空调清洗咨询，预约需提前1天；不提供安装服务。价格和优惠需商家确认。',
        warnings: ['请商家核对预约时间与服务限制。'],
      })
    : '我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。' +
      (messages.includes('预约需提前1天') ? ' 预约需提前1天；不提供安装服务。' : '');
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content,
          },
        },
      ],
    }),
  );
});

server.listen(9020, '127.0.0.1');
