import { createServer } from 'node:http';

for (const [name, port] of [
  ['merchant', 23000],
  ['consumer', 23001],
  ['ops', 23002],
  ['api', 24000],
]) {
  createServer((request, response) => {
    if (name === 'ops' && request.url === '/ops/') {
      response.writeHead(308, { location: '/ops' });
      response.end();
      return;
    }
    if (name === 'merchant' && request.url === '/console/') {
      response.writeHead(308, { location: '/console' });
      response.end();
      return;
    }
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(
      `${name}|${request.url}|${request.headers.host}|${request.headers['x-forwarded-proto']}`,
    );
  }).listen(port, '127.0.0.1');
}
