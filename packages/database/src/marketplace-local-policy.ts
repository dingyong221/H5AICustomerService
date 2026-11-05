/** No production identity adapter exists yet. Fixtures can never enable production. */
export function marketplaceFixtureEnabled(environment: NodeJS.ProcessEnv): boolean {
  if (
    environment['H5CS_MARKETPLACE_MODE'] !== 'local-fixture' ||
    !['development', 'test'].includes(environment['NODE_ENV'] ?? '') ||
    !['local', 'test'].includes(environment['APP_ENV'] ?? '')
  )
    return false;
  try {
    const origin = new URL(environment['MERCHANT_PUBLIC_ORIGIN'] ?? '');
    const database = new URL(environment['MYSQL_DATABASE_URL'] ?? '');
    return (
      origin.origin === environment['MERCHANT_PUBLIC_ORIGIN'] &&
      origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(origin.hostname) &&
      database.protocol === 'mysql:' &&
      ['127.0.0.1', 'localhost'].includes(database.hostname) &&
      database.pathname === '/h5cs_marketplace_a6_test' &&
      database.username === 'h5cs_a6_test' &&
      !database.search &&
      !database.hash
    );
  } catch {
    return false;
  }
}
