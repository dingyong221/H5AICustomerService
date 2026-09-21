import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env['MYSQL_DATABASE_URL'];

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('MYSQL_DATABASE_URL is required to run Drizzle commands');
}

export default defineConfig({
  dialect: 'mysql',
  out: './migrations',
  schema: './src/schema/index.ts',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
