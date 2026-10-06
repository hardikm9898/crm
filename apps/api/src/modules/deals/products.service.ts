import { Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import type { CreateProductInput, ListProductsQuery, UpdateProductInput } from './deals.dto.js';

/**
 * The product catalogue (`FR-DEAL-1`).
 *
 * Configuration, like statuses and sources: rows a tenant edits, never constants in code (rule 4).
 * `settings:manage` rather than `deal:manage` for the writes — a price list is a workspace decision,
 * and a sales executive quoting from it should not be able to change it.
 *
 * **Nothing reads a product at display time.** A line item copies the name, the price and the tax
 * rate when it is written, so a price change today cannot rewrite last quarter's quotations. That is
 * also why deleting a product that has been sold is refused by the database: deactivating it is what
 * a tenant actually wants, and `isActive` exists for that.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListProductsQuery) {
    const where: Record<string, unknown> = {
      deletedAt: null,
      ...(query.category ? { category: query.category } : {}),
      ...(query.active === undefined ? {} : { isActive: query.active }),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { sku: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.db.client.product.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((product) => this.present(product)),
      pagination: {
        limit: query.limit,
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > query.limit,
      },
    };
  }

  async findOne(id: string) {
    const product = await this.db.client.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw AppError.notFound('Product');
    return this.present(product);
  }

  async create(input: CreateProductInput) {
    const principal = tenantContext.require('products.create');
    await this.assertSkuFree(input.sku ?? null, null);

    const id = newId();
    await this.db.client.product.create({
      data: {
        id,
        organizationId: principal.organizationId,
        name: input.name,
        sku: input.sku ?? null,
        description: input.description ?? null,
        category: input.category ?? null,
        priceMinor: BigInt(input.priceMinor),
        currency: input.currency ?? null,
        taxPercent: input.taxPercent,
        unit: input.unit ?? null,
      },
    });
    await this.audit.record({
      action: 'product.created',
      resourceType: 'product',
      resourceId: id,
      after: { name: input.name, sku: input.sku ?? null, priceMinor: input.priceMinor },
    });
    return this.findOne(id);
  }

  async update(id: string, input: UpdateProductInput) {
    const existing = await this.db.client.product.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('Product');
    if (input.sku !== undefined) await this.assertSkuFree(input.sku ?? null, id);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.sku !== undefined) data['sku'] = input.sku ?? null;
    if (input.description !== undefined) data['description'] = input.description ?? null;
    if (input.category !== undefined) data['category'] = input.category ?? null;
    if (input.priceMinor !== undefined) data['priceMinor'] = BigInt(input.priceMinor);
    if (input.currency !== undefined) data['currency'] = input.currency ?? null;
    if (input.taxPercent !== undefined) data['taxPercent'] = input.taxPercent;
    if (input.unit !== undefined) data['unit'] = input.unit ?? null;
    if (input.isActive !== undefined) data['isActive'] = input.isActive;

    await this.db.client.product.update({ where: { id }, data });
    await this.audit.record({
      action: 'product.updated',
      resourceType: 'product',
      resourceId: id,
      before: { name: existing.name, priceMinor: Number(existing.priceMinor) },
      after: data,
    });
    return this.findOne(id);
  }

  /**
   * Soft delete, and only when nothing has been sold.
   *
   * The database refuses a hard delete of a sold product (`deal_items_product_same_org_fk`); this
   * refuses a *soft* delete too, with a sentence, because a deleted product that still appears on
   * last quarter's deals is a catalogue a person cannot reason about. Deactivating is the answer,
   * and the message says so.
   */
  async remove(id: string) {
    const product = await this.db.client.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw AppError.notFound('Product');

    const sold = await this.db.client.dealItem.count({ where: { productId: id } });
    if (sold > 0) {
      throw AppError.businessRule(
        `${product.name} is on ${sold} deal${sold === 1 ? '' : 's'}, so it cannot be deleted. ` +
          'Deactivate it instead — it will stop appearing when somebody adds a line.',
        { sold },
      );
    }

    await this.db.client.product.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record({
      action: 'product.deleted',
      resourceType: 'product',
      resourceId: id,
      before: { name: product.name },
    });
    return { id, deleted: true };
  }

  /** The partial unique index refuses this too; the check is here to answer with a sentence. */
  private async assertSkuFree(sku: string | null, exceptId: string | null): Promise<void> {
    if (sku === null) return;
    const clash = await this.db.client.product.findFirst({
      where: { sku, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, name: true },
    });
    if (clash) {
      throw AppError.conflict(`${clash.name} already uses the code ${sku}.`, 'CONFLICT');
    }
  }

  private present(product: {
    id: string;
    name: string;
    sku: string | null;
    description: string | null;
    category: string | null;
    priceMinor: bigint;
    currency: string | null;
    taxPercent: unknown;
    unit: string | null;
    isActive: boolean;
    createdAt: Date;
  }) {
    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      description: product.description,
      category: product.category,
      // BigInt does not survive JSON, so money crosses the wire as a number of minor units.
      priceMinor: Number(product.priceMinor),
      currency: product.currency,
      // Prisma returns a Decimal; the wire carries a number, which is exact for a 5,2 percentage.
      taxPercent: Number(product.taxPercent),
      unit: product.unit,
      isActive: product.isActive,
      createdAt: product.createdAt,
    };
  }
}
