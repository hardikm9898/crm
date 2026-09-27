import { Injectable } from '@nestjs/common';
import { newId, tenantContext, withPlatformScope } from '@leados/shared';
import { DbService } from '../db/db.service.js';

/**
 * Metered usage for per-period entitlements: WhatsApp messages, API calls, automation
 * actions (FR-BIL-4).
 *
 * Counters are stored per organization, metric and period so a monthly allowance resets
 * without deleting history. Increments are atomic upserts, because two concurrent sends must
 * not both read "999 of 1000" and both proceed.
 *
 * Countable *stock* limits (users, leads stored) are not metered here: they are counted from
 * the domain table, which cannot drift from reality.
 */
@Injectable()
export class UsageService {
  constructor(private readonly db: DbService) {}

  /** Current usage for the period containing `at`. */
  async current(
    metricKey: string,
    at: Date = new Date(),
    organizationId?: string,
  ): Promise<number> {
    const orgId = organizationId ?? tenantContext.organizationId(`usage:${metricKey}`);
    const { start } = monthlyPeriod(at);

    const counter = await withPlatformScope('usage: read counter', async () =>
      this.db.client.usageCounter.findUnique({
        where: {
          organizationId_metricKey_periodStart: {
            organizationId: orgId,
            metricKey,
            periodStart: start,
          },
        },
      }),
    );
    return counter ? Number(counter.used) : 0;
  }

  /** Atomically records consumption and returns the new total. */
  async increment(
    metricKey: string,
    quantity = 1,
    at: Date = new Date(),
    organizationId?: string,
  ): Promise<number> {
    const orgId = organizationId ?? tenantContext.organizationId(`usage:${metricKey}`);
    const { start, end } = monthlyPeriod(at);

    return withPlatformScope('usage: increment counter', async () => {
      const counter = await this.db.client.usageCounter.upsert({
        where: {
          organizationId_metricKey_periodStart: {
            organizationId: orgId,
            metricKey,
            periodStart: start,
          },
        },
        create: {
          id: newId(),
          organizationId: orgId,
          metricKey,
          periodStart: start,
          periodEnd: end,
          used: BigInt(quantity),
        },
        update: { used: { increment: BigInt(quantity) } },
      });
      return Number(counter.used);
    });
  }

  async markWarned(
    metricKey: string,
    at: Date = new Date(),
    organizationId?: string,
  ): Promise<void> {
    const orgId = organizationId ?? tenantContext.organizationId(`usage:${metricKey}`);
    const { start } = monthlyPeriod(at);
    await withPlatformScope('usage: mark warned', async () => {
      await this.db.client.usageCounter.updateMany({
        where: { organizationId: orgId, metricKey, periodStart: start, warnedAt: null },
        data: { warnedAt: new Date() },
      });
    });
  }
}

/**
 * Calendar-month periods in UTC. Deliberately not the organization's timezone: a usage window
 * that shifts per tenant makes cross-tenant reporting and invoicing ambiguous.
 */
export function monthlyPeriod(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}
