import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: resolve(import.meta.dirname, '../../../.env') });

const testDatabaseUrl = process.env['DATABASE_URL_TEST'];
if (testDatabaseUrl) process.env['DATABASE_URL'] = testDatabaseUrl;

// A separate Redis database, so throttle counters and cached grants from a previous run
// (or from the development app) cannot influence a test.
const testRedisUrl = process.env['REDIS_URL_TEST'];
if (testRedisUrl) process.env['REDIS_URL'] = testRedisUrl;
process.env['NODE_ENV'] = 'test';
// Tests are silent by default; set TEST_LOG_LEVEL=debug to see application logs.
process.env['LOG_LEVEL'] = process.env['TEST_LOG_LEVEL'] ?? 'silent';
