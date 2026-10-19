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

// Nothing in a test run may reach somebody else's server. Connecting a provider probes it
// immediately, so a `meta_lead_ads` or `whatsapp_cloud` connection built by any fixture would
// otherwise call Meta's real Graph API — from CI, with a token that is not a token. Pointed at a
// closed loopback port, which fails locally and in milliseconds; the two suites that need a Graph
// API run one in-process and override this for their own app.
process.env['META_GRAPH_URL'] = process.env['META_GRAPH_URL'] ?? 'http://127.0.0.1:1/v21.0';
