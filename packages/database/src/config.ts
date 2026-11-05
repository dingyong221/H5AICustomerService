import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

import type { Connection, ConnectionOptions } from 'mysql2/promise';
import { createConnection } from 'mysql2/promise';
import { z } from 'zod';

const mysqlUrlSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'mysql:') {
        context.addIssue({ code: 'custom', message: 'URL protocol must be mysql:' });
      }
      if (parsed.hostname.length === 0 || parsed.pathname.length <= 1) {
        context.addIssue({ code: 'custom', message: 'URL must include a host and database name' });
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'URL is invalid' });
    }
  });

const databaseEnvironmentSchema = z.object({
  MYSQL_DATABASE_URL: mysqlUrlSchema.optional(),
  MYSQL_TLS_CA_FILE: z.string().optional(),
  APP_ENV: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export type DatabaseConfigSummary = Readonly<{
  host: string;
  database: string;
  tlsRequested: boolean;
}>;

export type DatabaseConnectionConfig = Readonly<{
  openConnection: () => Promise<Connection>;
  summary: DatabaseConfigSummary;
  toJSON: () => DatabaseConfigSummary;
}>;

export type DatabaseConfigResult =
  | Readonly<{
      configured: false;
      reason:
        | 'MYSQL_DATABASE_URL is not set'
        | 'Managed MySQL requires a DNS hostname'
        | 'Managed MySQL requires ssl-mode=VERIFY_IDENTITY'
        | 'MYSQL_TLS_CA_FILE is missing or invalid'
        | 'Production MySQL cannot use a loopback host';
    }>
  | Readonly<{ configured: true; config: DatabaseConnectionConfig }>;

type ConnectionFactory = (options: ConnectionOptions) => Promise<Connection>;

const localHost = (host: string): boolean => host === 'localhost' || host === '127.0.0.1';

const readCertificateAuthority = (path: string | undefined): string | null => {
  if (!path || !isAbsolute(path)) return null;
  try {
    const pem = readFileSync(path, 'utf8');
    return pem.length <= 262_144 &&
      /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/u.test(pem)
      ? pem
      : null;
  } catch {
    return null;
  }
};

export const loadDatabaseConfig = (
  environment: NodeJS.ProcessEnv = process.env,
  connect: ConnectionFactory = createConnection,
): DatabaseConfigResult => {
  const parsedEnvironment = databaseEnvironmentSchema.parse(environment);
  const databaseUrl = parsedEnvironment.MYSQL_DATABASE_URL;

  if (databaseUrl === undefined) {
    return { configured: false, reason: 'MYSQL_DATABASE_URL is not set' };
  }

  const parsedUrl = new URL(databaseUrl);
  if (
    parsedUrl.hash ||
    [...parsedUrl.searchParams.keys()].some((key) => key !== 'ssl-mode') ||
    parsedUrl.searchParams.getAll('ssl-mode').length > 1
  ) {
    throw new Error('Unsupported MySQL URL option');
  }
  const host = parsedUrl.hostname;
  const loopback = localHost(host);
  const production =
    parsedEnvironment.NODE_ENV === 'production' || parsedEnvironment.APP_ENV === 'production';
  if (production && loopback) {
    return { configured: false, reason: 'Production MySQL cannot use a loopback host' };
  }
  if (!loopback && isIP(host.replace(/^\[|\]$/gu, '')) !== 0) {
    return { configured: false, reason: 'Managed MySQL requires a DNS hostname' };
  }
  const mode = parsedUrl.searchParams.get('ssl-mode');
  if ((!loopback || production) && mode !== 'VERIFY_IDENTITY') {
    return { configured: false, reason: 'Managed MySQL requires ssl-mode=VERIFY_IDENTITY' };
  }
  if (mode !== null && mode !== 'VERIFY_IDENTITY') {
    return { configured: false, reason: 'Managed MySQL requires ssl-mode=VERIFY_IDENTITY' };
  }
  const ca =
    mode === 'VERIFY_IDENTITY'
      ? readCertificateAuthority(parsedEnvironment.MYSQL_TLS_CA_FILE)
      : null;
  if (mode === 'VERIFY_IDENTITY' && ca === null) {
    return { configured: false, reason: 'MYSQL_TLS_CA_FILE is missing or invalid' };
  }
  if (mode === null && parsedEnvironment.MYSQL_TLS_CA_FILE) {
    return { configured: false, reason: 'Managed MySQL requires ssl-mode=VERIFY_IDENTITY' };
  }
  const ssl: ConnectionOptions['ssl'] = ca
    ? { ca, rejectUnauthorized: true, verifyIdentity: true }
    : undefined;
  const options: ConnectionOptions = {
    host,
    // All persisted DATETIME values are UTC, independent of workstation/server TZ.
    timezone: 'Z',
    port: parsedUrl.port ? Number(parsedUrl.port) : 3306,
    user: decodeURIComponent(parsedUrl.username),
    password: decodeURIComponent(parsedUrl.password),
    database: decodeURIComponent(parsedUrl.pathname.slice(1)),
    ...(ssl ? { ssl } : {}),
  };
  const summary: DatabaseConfigSummary = Object.freeze({
    host,
    database: decodeURIComponent(parsedUrl.pathname.slice(1)),
    tlsRequested: ssl !== undefined,
  });

  const config: DatabaseConnectionConfig = Object.freeze({
    summary,
    openConnection: () => connect(options),
    toJSON: () => summary,
  });

  return { configured: true, config };
};

export type DatabaseProbeResult =
  | Readonly<{ ok: true; latencyMs: number }>
  | Readonly<{ ok: false; latencyMs: number; reason: 'connection_failed' }>;

export const probeDatabase = async (
  config: DatabaseConnectionConfig,
): Promise<DatabaseProbeResult> => {
  const startedAt = performance.now();
  let connection: Connection | undefined;

  try {
    connection = await config.openConnection();
    await connection.ping();
    return { ok: true, latencyMs: Math.max(0, performance.now() - startedAt) };
  } catch {
    return {
      ok: false,
      latencyMs: Math.max(0, performance.now() - startedAt),
      reason: 'connection_failed',
    };
  } finally {
    await connection?.end().catch(() => undefined);
  }
};
