import { Injectable } from '@nestjs/common';
import { newId, tenantContext } from '@leados/shared';
import type { DbTransactionClient, Prisma } from '@leados/db';

/**
 * The write half of the transactional outbox (ADR-0006).
 *
 * Events are inserted **inside the caller's transaction**, so a committed state change
 * can never exist without its events, and a rolled-back one can never leave events
 * behind. The dispatcher that moves them onto queues arrives in Phase 1 step 4; until
 * then rows accumulate and `/health/deep` reports the lag, which is the honest
 * behaviour — nothing is lost, it is simply not consumed yet.
 */

export interface DomainEventInput {
  readonly name: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly version?: number;
  /** Depth of automation-caused chains; the automation engine uses it for loop detection. */
  readonly causationDepth?: number;
  readonly causationId?: string;
}

/** Re-exported for callers that pass a transaction around. */
export type TransactionClient = DbTransactionClient;

@Injectable()
export class OutboxService {
  /**
   * @param tx  The transaction the state change is being written in. Required on purpose:
   *            there is no method that emits outside a transaction, because that would
   *            reintroduce the lost-event window the outbox exists to close.
   */
  async emit(
    tx: TransactionClient,
    events: readonly DomainEventInput[],
    context?: { organizationId?: string | null; correlationId?: string },
  ): Promise<string[]> {
    if (events.length === 0) return [];

    const principal = tenantContext.get();
    const organizationId =
      context?.organizationId !== undefined
        ? context.organizationId
        : (principal?.organizationId ?? null);

    const rows = events.map((event) => ({
      id: newId(),
      eventId: newId(),
      organizationId,
      eventName: event.name,
      eventVersion: event.version ?? 1,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload as Prisma.InputJsonValue,
      actorType: principal?.actorType ?? 'system',
      actorId: principal?.actorId ?? null,
      correlationId: context?.correlationId ?? principal?.requestId ?? null,
      causationId: event.causationId ?? null,
      causationDepth: event.causationDepth ?? 0,
    }));

    await tx.outboxEvent.createMany({ data: rows });
    return rows.map((row) => row.eventId);
  }
}
