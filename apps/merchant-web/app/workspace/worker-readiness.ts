const internalReadinessUrl = (value: string | undefined, production: boolean): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (
      url.pathname !== '/readyz' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      (production
        ? url.protocol !== 'http:' || url.hostname !== 'worker' || url.port !== '3011'
        : url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.href !== value
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
};

export async function workerReady(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = internalReadinessUrl(
    environment['WORKER_READINESS_URL'],
    environment['NODE_ENV'] === 'production',
  );
  if (!url) return false;
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(2_000),
    });
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.includes('application/json')
    ) {
      return false;
    }
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      !('data' in body) ||
      typeof body.data !== 'object' ||
      body.data === null ||
      Array.isArray(body.data)
    )
      return false;
    const data = body.data as Record<string, unknown>;
    if (
      data['status'] !== 'ready' ||
      data['service'] !== 'worker' ||
      typeof data['checks'] !== 'object' ||
      data['checks'] === null ||
      Array.isArray(data['checks'])
    )
      return false;
    const checks = data['checks'] as Record<string, unknown>;
    return (
      typeof checks['database'] === 'object' &&
      checks['database'] !== null &&
      'status' in checks['database'] &&
      checks['database'].status === 'up' &&
      typeof checks['conversation'] === 'object' &&
      checks['conversation'] !== null &&
      'status' in checks['conversation'] &&
      checks['conversation'].status === 'up'
    );
  } catch {
    return false;
  }
}
