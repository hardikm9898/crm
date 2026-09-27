import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The workspace keeps one .env at the repository root; load it explicitly rather than
// relying on the current working directory, so `prisma migrate` behaves the same whether
// it is run from here, from the root, or from CI.
loadDotenv({ path: resolve(import.meta.dirname, '../../.env'), quiet: true });

/**
 * Prisma 7 moved the connection URL out of schema.prisma: migrations read it from here,
 * and the runtime client receives a driver adapter instead (see src/client.ts and
 * docs/database-design.md §1).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] },
});
