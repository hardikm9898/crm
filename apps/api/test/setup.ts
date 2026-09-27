import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: resolve(import.meta.dirname, '../../../.env') });

const testUrl = process.env['DATABASE_URL_TEST'];
if (testUrl) process.env['DATABASE_URL'] = testUrl;
process.env['NODE_ENV'] = 'test';
// Tests are silent by default; set TEST_LOG_LEVEL=debug to see application logs.
process.env['LOG_LEVEL'] = process.env['TEST_LOG_LEVEL'] ?? 'silent';
