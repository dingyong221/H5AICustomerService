import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const databaseRequire = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
);
const { createConnection } = databaseRequire('mysql2/promise');
const { drizzle } = databaseRequire('drizzle-orm/mysql2');
const { migrate } = databaseRequire('drizzle-orm/mysql2/migrator');
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.APP_ENV !== 'test' ||
  !process.env.H5CS_A6_LOCAL_TEST_PASSWORD ||
  process.argv.slice(2).join(' ') !== '--new-isolated-runtime'
)
  throw new Error('Explicit A6 isolated runtime required');
// Only for the new artifact-local process launched on this dedicated port, never a service installation.
const password = process.env.H5CS_A6_LOCAL_TEST_PASSWORD;
const connection = await createConnection({
  host: '127.0.0.1',
  port: 33186,
  user: 'root',
  password: '',
});
try {
  const [version] = await connection.query('SELECT VERSION() version, @@datadir data_dir');
  const expectedDataDir = fileURLToPath(
    new URL('../../artifacts/ai-supermarket-a6/mysql-runtime/a6-data/', import.meta.url),
  );
  if (resolve(version[0].data_dir).toLowerCase() !== resolve(expectedDataDir).toLowerCase())
    throw new Error('Refusing a different MySQL data directory');
  if (!/^8\.4\./u.test(version[0].version)) throw new Error('MySQL 8.4 test runtime required');
  await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [password]);
  await connection.query(
    'CREATE DATABASE h5cs_marketplace_a6_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  );
  await connection.query("CREATE USER 'h5cs_a6_test'@'127.0.0.1' IDENTIFIED BY ?", [password]);
  await connection.query(
    "GRANT ALL PRIVILEGES ON h5cs_marketplace_a6_test.* TO 'h5cs_a6_test'@'127.0.0.1'",
  );
} finally {
  await connection.end();
}
const scoped = await createConnection({
  host: '127.0.0.1',
  port: 33186,
  user: 'h5cs_a6_test',
  password,
  database: 'h5cs_marketplace_a6_test',
});
try {
  await migrate(drizzle(scoped), {
    migrationsFolder: fileURLToPath(
      new URL('../../packages/database/migrations/', import.meta.url),
    ),
  });
  const [tables] = await scoped.query('SHOW TABLES');
  process.stdout.write(
    JSON.stringify({
      dedicatedLocalDatabase: true,
      appliedMigrationCount: JSON.parse(
        await readFile(
          new URL('../../packages/database/migrations/meta/_journal.json', import.meta.url),
          'utf8',
        ),
      ).entries.length,
      tableCount: tables.length,
      listen: '127.0.0.1:33186',
    }) + '\n',
  );
} finally {
  await scoped.end();
}
