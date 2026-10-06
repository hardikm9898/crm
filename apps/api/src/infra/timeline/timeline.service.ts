import { Injectable } from '@nestjs/common';
import {
  newId,
  tenantContext,
  type ActivityType,
  type ActivityVisibility,
  type ActorType,
} from '@leados/shared';
import { DbService } from '../db/db.service.js';
import { requestStore } from '../http/request-store.js';
import type { Prisma } from '@leados/db';
import type { TransactionClient } from '../outbox/outbox.service.js';

/**
 * The append-only timeline writer (ADR-0009, rule 6).
 *
 * Structurally this belongs with `AuditService` and `OutboxService` rather than with a domain module:
 * every feature writes to it, and it holds no logic of its own. The read side — filtering, grouping,
 * pagination — is a product surface and lives in `modules/timeline`.
 *
 * Three things it enforces, so no caller has to remember them:
 *
 *  * **`occurredAt` is required, never defaulted to `now()`.** The table is partitioned by that
 *    column and its idempotency key includes it, so a retry that re-derived the instant would write a
 *    second row rather than colliding. Requiring the argument makes that impossible to get wrong by
 *    omission (see the note on `Activity` in the schema).
 *  * **Actor attribution is ambient.** Taken from the tenant context, exactly as the audit trail does
 *    it, so an entry cannot claim to be someone else.
 *  * **There is no update and no delete.** Append-only is the whole value: a timeline you can edit is
 *    a timeline nobody can rely on.
 */

export interface TimelineEntry {
  readonly type: ActivityType;
  readonly leadId?: string | null;
  /**
   * The customer this entry belongs to, for activity after a conversion.
   *
   * A converted person's history is read as the union of their lead's entries and their customer's
   * (`FR-DEAL-4`), so an entry names whichever subject it actually happened to — never both, and
   * never the lead retrospectively. Re-parenting the lead's entries onto the customer would be the
   * one way to lose a touchpoint, which is exactly what the requirement forbids.
   */
  readonly customerId?: string | null;
  /** When it happened. Required — see the class comment. */
  readonly occurredAt: Date;
  readonly payload?: Record<string, unknown>;
  readonly visibility?: ActivityVisibility;
  /** The domain event that caused this, when there was one. Makes a job retry a no-op. */
  readonly sourceEventId?: string | null;
  /** Overrides the ambient actor, for entries written by a job on a person's behalf. */
  readonly actorType?: ActorType;
  readonly actorId?: string | null;
  /**
   * A name for a non-person actor — "Round-robin rule", "WhatsApp webhook". People are resolved from
   * `users` at read time instead, so a rename shows everywhere and a departure degrades to a label
   * rather than a blank.
   */
  readonly actorLabel?: string | null;
}

/** Postgres unique-violation. A replayed event is a success, not an error. */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class TimelineService {
  constructor(private readonly db: DbService) {}

  /**
   * Records inside the transaction that caused the change — the preferred form, so a lead and its
   * `lead.created` entry either both exist or neither does.
   */
  async recordInTransaction(tx: TransactionClient, entry: TimelineEntry): Promise<void> {
    await this.write(tx, entry);
  }

  /** Records outside a transaction, for entries produced by a job rather than by a write. */
  async record(entry: TimelineEntry): Promise<void> {
    await this.write(this.db.client, entry);
  }

  /** Records several entries in one statement — a bulk action produces one row per lead. */
  async recordManyInTransaction(
    tx: TransactionClient,
    entries: readonly TimelineEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const organizationId = tenantContext.organizationId('timeline.recordMany');
    await tx.activity.createMany({
      data: entries.map((entry) => this.buildRow(entry, organizationId)),
      // A bulk action that partially replays must not fail the whole batch; the unique constraint
      // still guarantees at most one row per source event.
      skipDuplicates: true,
    });
  }

  private async write(client: TransactionClient, entry: TimelineEntry): Promise<void> {
    const organizationId = tenantContext.organizationId('timeline.record');
    try {
      await client.activity.create({ data: this.buildRow(entry, organizationId) });
    } catch (error) {
      // An idempotency collision means the entry is already there, which is the desired end state.
      // Swallowing it here is what lets a job processor be safely retried.
      if (isUniqueViolation(error) && entry.sourceEventId) return;
      throw error;
    }
  }

  private buildRow(
    entry: TimelineEntry,
    organizationId: string,
  ): {
    id: string;
    organizationId: string;
    leadId: string | null;
    customerId: string | null;
    type: string;
    actorType: ActorType;
    actorId: string | null;
    actorLabel: string | null;
    occurredAt: Date;
    payload: Prisma.InputJsonValue;
    visibility: ActivityVisibility;
    sourceEventId: string | null;
  } {
    const principal = tenantContext.get();
    return {
      id: newId(),
      organizationId,
      leadId: entry.leadId ?? null,
      customerId: entry.customerId ?? null,
      type: entry.type,
      actorType: entry.actorType ?? principal?.actorType ?? 'system',
      actorId: entry.actorId ?? principal?.actorId ?? null,
      actorLabel: entry.actorLabel ?? null,
      occurredAt: entry.occurredAt,
      payload: {
        ...(entry.payload ?? {}),
        // The request id ties a timeline entry to the log line and the audit row for the same action.
        ...(requestStore.requestId() ? { requestId: requestStore.requestId() } : {}),
      } as Prisma.InputJsonValue,
      visibility: entry.visibility ?? 'all',
      sourceEventId: entry.sourceEventId ?? null,
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}
