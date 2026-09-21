import type { Connection } from 'mysql2/promise';
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
  | Readonly<{ configured: false; reason: 'MYSQL_DATABASE_URL is not set' }>
  | Readonly<{ configured: true; config: DatabaseConnectionConfig }>;

export const loadDatabaseConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfigResult => {
  const parsedEnvironment = databaseEnvironmentSchema.parse(environment);
  const databaseUrl = parsedEnvironment.MYSQL_DATABASE_URL;

  if (databaseUrl === undefined) {
    return { configured: false, reason: 'MYSQL_DATABASE_URL is not set' };
  }

  const parsedUrl = new URL(databaseUrl);
  const summary: DatabaseConfigSummary = Object.freeze({
    host: parsedUrl.hostname,
    database: decodeURIComponent(parsedUrl.pathname.slice(1)),
    tlsRequested:
      parsedUrl.searchParams.get('ssl-mode') !== null ||
      parsedUrl.searchParams.get('ssl') === 'true',
  });

  const config: DatabaseConnectionConfig = Object.freeze({
    summary,
    openConnection: () => createConnection(databaseUrl),
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
