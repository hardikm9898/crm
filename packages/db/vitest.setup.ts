import { resolve } from 'node:path';
import { config } from 'dotenv';

// Integration tests use their own database, so a failing test can never corrupt
// development data (docs/deployment-architecture.md §1).
config({ path: resolve(import.meta.dirname, '../../.env') });

const testUrl = process.env['DATABASE_URL_TEST'];
if (testUrl) process.env['DATABASE_URL'] = testUrl;
