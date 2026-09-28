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
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64_000) throw new Error('Request exceeds browser-test limit');
    }
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
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
            content: '我们提供上门空调清洗服务。具体价格和服务范围请向商家确认。',
          },
        },
      ],
    }),
  );
});

server.listen(9020, '127.0.0.1');
