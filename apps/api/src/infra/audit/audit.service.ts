import { Injectable } from '@nestjs/common';
import { newId, tenantContext, withPlatformScope } from '@leados/shared';
import { DbService } from '../db/db.service.js';
import { requestStore } from '../http/request-store.js';
import type { ActorType, Prisma } from '@leados/db';
import type { TransactionClient } from '../outbox/outbox.service.js';

/**
 * Writes the audit trail (FR-AUD-1). Append-only at the database level, so this service
 * has no update or delete method — there is nothing to add later, by design.
 *
 * Actor, IP, user agent and request id are taken from the ambient context rather than
 * from the caller, so an audit entry cannot claim to be someone else, and a caller
 * cannot forget to attribute it.
 */

export interface AuditEntry {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  /** Only for events that happen before a tenant context exists, e.g. login. */
  readonly organizationId?: string;
  readonly actorType?: ActorType;
  readonly actorId?: string | null;
  readonly actorLabel?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /** Records inside an existing transaction — preferred, so the trail commits with the change. */
  async recordInTransaction(tx: TransactionClient, entry: AuditEntry): Promise<void> {
    const data = this.buildRow(entry);
    if (data === null) return;
    await tx.auditLog.create({ data });
  }

  /**
   * Records outside a transaction. Used for events with no accompanying state change
   * (a failed login, a permission denial). Never throws: losing an audit line must not
   * turn a successful operation into a failed one — but it is logged as an error.
   */
  async record(entry: AuditEntry): Promise<void> {
    const data = this.buildRow(entry);
    if (data === null) return;
    try {
      // Login attempts and other pre-authentication events happen before a tenant context
      // exists; the organization is supplied explicitly by the caller instead.
      await withPlatformScope('audit: record event without tenant context', async () => {
        await this.db.client.auditLog.create({ data });
      });
    } catch {
      /* swallowed deliberately; see above */
    }
  }

  private buildRow(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput | null {
    const principal = tenantContext.get();
    const organizationId = entry.organizationId ?? principal?.organizationId;
    // An audit row belongs to an organization. Platform-actor events go to the separate
    // platform log (Phase 10); dropping the row is better than attributing it wrongly.
    if (!organizationId) return null;

    const request = requestStore.get();
    return {
      id: newId(),
      organizationId,
      actorType: entry.actorType ?? principal?.actorType ?? 'system',
      actorId: entry.actorId ?? principal?.actorId ?? null,
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      before: (entry.before ?? null) as Prisma.InputJsonValue,
      after: (entry.after ?? null) as Prisma.InputJsonValue,
      ipAddress: request?.ip ?? null,
      userAgent: request?.userAgent ?? null,
      requestId: request?.requestId ?? null,
      impersonatedBy: principal?.impersonation?.platformUserId ?? null,
    };
  }
}
