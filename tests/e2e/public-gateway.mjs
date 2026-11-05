import http from 'node:http';

const host = '127.0.0.1';

http
  .createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', `http://${host}`).pathname;
    if (pathname === '/_gateway-health') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }

    const singleDomain = process.env['H5CS_E2E_PATH_MODE'] === 'single_domain';
    const targetPort =
      pathname === '/console/usage'
        ? 3000
        : pathname === '/api/v1/public' ||
            pathname.startsWith('/api/v1/public/') ||
            (singleDomain && pathname.startsWith('/api/'))
          ? 4000
          : singleDomain && (pathname === '/ops' || pathname.startsWith('/ops/'))
            ? 3002
            : singleDomain &&
                (pathname === '/console' ||
                  pathname.startsWith('/console/') ||
                  /^\/[0-9a-f]{32}(?:\/|$)/u.test(pathname))
              ? 3000
              : 3003;
    const upstream = http.request(
      {
        hostname: host,
        port: targetPort,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `${host}:3001` },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  })
  .listen(3001, host);
