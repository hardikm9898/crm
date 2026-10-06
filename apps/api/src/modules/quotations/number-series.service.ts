import { Injectable } from '@nestjs/common';
import { AppError, formatDocumentNumber, newId, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import type { TransactionClient } from '../../infra/outbox/outbox.service.js';
import type { UpdateNumberSeriesInput } from './quotations.dto.js';

export const NUMBER_SERIES_KINDS = { QUOTATION: 'quotation' } as const;

/**
 * Handing out the next document number for a workspace (`FR-DEAL-2`).
 *
 * Three things could have produced a number and two of them are wrong:
 *
 *  * **`MAX(number) + 1`** is a read-then-write on rows other transactions are inserting. Two
 *    people raising a quotation in the same second both read 6 and both write `QTN-0007`; one of
 *    them loses to the unique index at best, and at worst the numbers simply repeat. This is the
 *    same trap as the scoring queue's double-write, and it has the same answer: read the number you
 *    are about to advance **after** taking the row lock.
 *  * **A Postgres sequence** is global. One workspace's quotations would advance another's
 *    numbering, so a tenant could watch `QTN-0007` jump to `QTN-0130` and read off how much
 *    business the platform did that week.
 *  * **One counter row per `(organization, kind)`, locked with `SELECT … FOR UPDATE`** inside the
 *    transaction that writes the document. The lock is held for one insert, contention is per
 *    workspace, and the numbers are gapless unless a transaction rolls back — which is the correct
 *    behaviour for a document series: a number that was allocated and then abandoned is a document
 *    somebody may already have seen.
 *
 * The prefix and the padding are the tenant's (`CLAUDE.md` rule 4), so this service also owns
 * reading and changing the series — including the one refusal that matters: a counter only ever
 * moves forward.
 */
@Injectable()
export class NumberSeriesService {
  constructor(private readonly db: DbService) {}

  /**
   * The next number for `kind`, and the counter advanced, inside the caller's transaction.
   *
   * Takes `tx` rather than opening its own: the number and the document must commit or roll back
   * together, or a crash between them burns a number and leaves a gap nobody can explain.
   */
  async allocate(tx: TransactionClient, kind: string): Promise<{ number: string; value: number }> {
    const organizationId = tenantContext.organizationId('number-series.allocate');
    await this.ensure(kind);

    // Raw SQL because Prisma has no `FOR UPDATE`. The predicate names the organization explicitly:
    // a raw query bypasses the scoped client, so the tenant check cannot be inherited here.
    const locked = await tx.$queryRaw<{ next_value: number; prefix: string; padding: number }[]>`
      SELECT next_value, prefix, padding
        FROM number_series
       WHERE organization_id = ${organizationId}::uuid
         AND kind = ${kind}
         FOR UPDATE
    `;
    const row = locked[0];
    if (!row) throw AppError.internal('That number series could not be read');

    const value = Number(row.next_value);
    await tx.$executeRaw`
      UPDATE number_series
         SET next_value = ${value + 1}, updated_at = now()
       WHERE organization_id = ${organizationId}::uuid
         AND kind = ${kind}
    `;

    return {
      number: formatDocumentNumber({ prefix: row.prefix, padding: Number(row.padding) }, value),
      value,
    };
  }

  /** The series as a settings screen reads it, created on first sight. */
  async read(kind: string) {
    const row = await this.ensure(kind);
    return {
      kind: row.kind,
      prefix: row.prefix,
      padding: row.padding,
      nextValue: row.nextValue,
      nextNumber: formatDocumentNumber({ prefix: row.prefix, padding: row.padding }, row.nextValue),
    };
  }

  async update(kind: string, input: UpdateNumberSeriesInput) {
    const current = await this.ensure(kind);
    if (input.nextValue !== undefined && input.nextValue < current.nextValue) {
      // Rewinding would re-issue a number that is already in somebody's inbox. Moving it forward
      // is legitimate and common: a business migrating from a spreadsheet starts at 1 240.
      throw AppError.businessRule(
        `The counter is already at ${current.nextValue}. It can be moved forward, but not back — an earlier number has already been used.`,
      );
    }
    await this.db.client.numberSeries.update({
      where: { id: current.id },
      data: {
        prefix: input.prefix,
        padding: input.padding,
        ...(input.nextValue !== undefined ? { nextValue: input.nextValue } : {}),
      },
    });
    return this.read(kind);
  }

  /**
   * The series row, created with defaults the first time anybody asks.
   *
   * Lazily rather than seeded per organization, so workspaces that existed before this feature get
   * one without a backfill, and so there is exactly one code path that can create it.
   */
  private async ensure(kind: string) {
    const principal = tenantContext.require('number-series.ensure');
    const existing = await this.db.client.numberSeries.findFirst({ where: { kind } });
    if (existing) return existing;
    return this.db.client.numberSeries.create({
      data: {
        id: newId(),
        organizationId: principal.organizationId,
        kind,
        prefix: defaultPrefixFor(kind),
        padding: 4,
        nextValue: 1,
      },
    });
  }
}

function defaultPrefixFor(kind: string): string {
  return kind === NUMBER_SERIES_KINDS.QUOTATION ? 'QTN-' : `${kind.toUpperCase()}-`;
}
