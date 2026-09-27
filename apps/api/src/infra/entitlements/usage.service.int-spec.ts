import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken, systemPrincipal, tenantContext } from '@leados/shared';
import { createUnscopedDbClient, type UnscopedDbClient } from '@leados/db';
import { UsageService, monthlyPeriod } from './usage.service.js';
import type { DbService } from '../db/db.service.js';

/**
 * Usage counters back the per-period entitlements (WhatsApp messages, API calls).
 *
 * The property worth testing against a real database is **atomicity**: two concurrent sends
 * must not both read "999 of 1000" and both proceed, which is exactly the bug a
 * read-then-write implementation would have.
 */
let db: UnscopedDbClient;
let usage: UsageService;
let organizationId: string;

beforeAll(async () => {
  db = createUnscopedDbClient({ connectionString: process.env['DATABASE_URL']!, poolMax: 5 });
  usage = new UsageService({ client: db } as unknown as DbService);

  organizationId = newId();
  await db.organization.create({
    data: {
      id: organizationId,
      slug: `usage-${newToken(5)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')}`,
      name: 'Usage Test Org',
      publicKey: `pk_test_${newToken(10)}`,
      status: 'active',
    },
  });
}, 60_000);

afterAll(async () => {
  if (db) {
    await db.usageCounter.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
    await db.$disconnect();
  }
});

const asOrg = <T>(fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(systemPrincipal(organizationId, 'usage-test'), fn);

describe('monthlyPeriod', () => {
  it('uses calendar months in UTC, not the tenant timezone', () => {
    // A per-tenant window would make invoicing and cross-tenant reporting ambiguous.
    const { start, end } = monthlyPeriod(new Date('2026-09-27T19:30:00Z'));
    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rolls over at a year boundary', () => {
    const { start, end } = monthlyPeriod(new Date('2026-12-15T00:00:00Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('UsageService', () => {
  it('starts at zero and accumulates', async () => {
    await asOrg(async () => {
      expect(await usage.current('whatsapp_messages_monthly')).toBe(0);
      expect(await usage.increment('whatsapp_messages_monthly', 3)).toBe(3);
      expect(await usage.increment('whatsapp_messages_monthly')).toBe(4);
      expect(await usage.current('whatsapp_messages_monthly')).toBe(4);
    });
  });

  it('counts concurrent increments exactly once each', async () => {
    await asOrg(async () => {
      await Promise.all(Array.from({ length: 25 }, () => usage.increment('api_calls_monthly')));
      // A read-then-write implementation would lose updates here.
      expect(await usage.current('api_calls_monthly')).toBe(25);
    });
  });

  it('keeps metrics and periods separate, so an allowance resets without losing history', async () => {
    const lastMonth = new Date('2026-08-15T00:00:00Z');
    await asOrg(async () => {
      await usage.increment('whatsapp_messages_monthly', 7, lastMonth);
      expect(await usage.current('whatsapp_messages_monthly', lastMonth)).toBe(7);
      // The current period is unaffected by the earlier one.
      expect(await usage.current('whatsapp_messages_monthly')).toBe(4);
    });

    const rows = await db.usageCounter.findMany({ where: { organizationId } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('records that a warning was sent, only once', async () => {
    await asOrg(async () => {
      await usage.markWarned('whatsapp_messages_monthly');
      const { start } = monthlyPeriod(new Date());
      const first = await db.usageCounter.findUniqueOrThrow({
        where: {
          organizationId_metricKey_periodStart: {
            organizationId,
            metricKey: 'whatsapp_messages_monthly',
            periodStart: start,
          },
        },
      });
      expect(first.warnedAt).not.toBeNull();

      await usage.markWarned('whatsapp_messages_monthly');
      const second = await db.usageCounter.findUniqueOrThrow({
        where: {
          organizationId_metricKey_periodStart: {
            organizationId,
            metricKey: 'whatsapp_messages_monthly',
            periodStart: start,
          },
        },
      });
      expect(second.warnedAt?.getTime()).toBe(first.warnedAt?.getTime());
    });
  });

  it('refuses to count without a tenant context', async () => {
    await expect(usage.increment('api_calls_monthly')).rejects.toThrow(/No tenant context/);
  });
});
