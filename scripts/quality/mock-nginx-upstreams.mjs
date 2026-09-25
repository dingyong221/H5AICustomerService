import { createServer } from 'node:http';

for (const [name, port] of [
  ['merchant', 23000],
  ['consumer', 23001],
  ['ops', 23002],
  ['api', 24000],
]) {
  createServer((request, response) => {
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(
      `${name}|${request.url}|${request.headers.host}|${request.headers['x-forwarded-proto']}`,
    );
  }).listen(port, '127.0.0.1');
}
