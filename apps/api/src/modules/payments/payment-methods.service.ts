import { Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import type { CreatePaymentMethodInput, UpdatePaymentMethodInput } from './payments.dto.js';

/**
 * How money arrives, as the tenant's own list (`FR-DEAL-3`, `CLAUDE.md` rule 4).
 *
 * A table rather than a CHECK, for the same reason `lost_reasons` is one: a reconciliation report
 * groups by it, a dropdown offers it, and the right answers differ per business. Code never checks
 * a method's name — only that the row belongs to this workspace.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive = false) {
    const rows = await this.db.client.paymentMethod.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const items = rows.map((row) => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sortOrder,
      requiresReference: row.requiresReference,
      isActive: row.isActive,
    }));
    return { items, pagination: { limit: items.length, nextCursor: null, hasMore: false } };
  }

  async create(input: CreatePaymentMethodInput) {
    const organizationId = tenantContext.organizationId('payments.createMethod');
    const id = newId();
    const highest = await this.db.client.paymentMethod.aggregate({ _max: { sortOrder: true } });
    await this.db.client.paymentMethod.create({
      data: {
        id,
        organizationId,
        name: input.name,
        requiresReference: input.requiresReference,
        sortOrder: input.sortOrder ?? (highest._max.sortOrder ?? -1) + 1,
      },
    });
    await this.audit.record({
      action: 'payment_method.created',
      resourceType: 'payment_method',
      resourceId: id,
      after: { name: input.name, requiresReference: input.requiresReference },
    });
    return { id, name: input.name };
  }

  async update(id: string, input: UpdatePaymentMethodInput) {
    const existing = await this.db.client.paymentMethod.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw AppError.notFound('Payment method');

    await this.db.client.paymentMethod.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.requiresReference === undefined
          ? {}
          : { requiresReference: input.requiresReference }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });
    await this.audit.record({
      action: 'payment_method.updated',
      resourceType: 'payment_method',
      resourceId: id,
      before: { name: existing.name, isActive: existing.isActive },
      after: { ...input },
    });
    return { id, name: input.name ?? existing.name };
  }

  /**
   * Refused once the method has been used, with the thing a tenant actually wants instead.
   *
   * Deleting it would take the record of *how* that money arrived with it, which is the one thing a
   * reconciliation needs — the same reasoning as a product that has been sold.
   */
  async remove(id: string) {
    const existing = await this.db.client.paymentMethod.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw AppError.notFound('Payment method');

    const used = await this.db.client.payment.count({ where: { methodId: id } });
    if (used > 0) {
      throw AppError.businessRule(
        `${existing.name} has been used on ${used} payment${used === 1 ? '' : 's'}, so it cannot be deleted — a reconciliation needs to know how that money arrived. Deactivate it instead and it will stop appearing on the form.`,
      );
    }

    await this.db.client.paymentMethod.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    await this.audit.record({
      action: 'payment_method.deleted',
      resourceType: 'payment_method',
      resourceId: id,
      before: { name: existing.name },
    });
    return { deleted: true };
  }
}
