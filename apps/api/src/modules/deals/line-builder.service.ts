import { Injectable } from '@nestjs/common';
import { AppError, LineItemError, lineTotals, newId, type LineItemInput } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import type { TransactionClient } from '../../infra/outbox/outbox.service.js';

/**
 * Turning what a client sent into priced lines, once, for every document that has lines.
 *
 * A deal and a quotation have the same line shape on purpose, and an invoice will make three. The
 * arithmetic already lives in exactly one place
 * ([ADR-0018](../../../../../docs/decisions/ADR-0018-money-arithmetic-in-one-place.md)); this is the
 * other half of that decision — the part that reads the catalogue, decides what the line is called,
 * and reports a bad line **at its own index**. Duplicating it per document type is how a quotation
 * ends up filling the product's price where a deal would not, or numbering the failing line
 * differently.
 *
 * What it deliberately does *not* own is where the rows go: `write()` takes the table and the parent
 * column, because `deal_items` and `quotation_items` are separate tables (a document must not change
 * when the deal moves on) with identical columns.
 */
export interface LineItemRequest {
  readonly productId?: string | null | undefined;
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly quantity: number;
  readonly unit?: string | null | undefined;
  readonly unitPriceMinor?: number | undefined;
  readonly discountMinor: number;
  readonly taxPercent?: number | undefined;
}

export interface BuiltLine {
  readonly input: LineItemInput;
  readonly position: number;
  readonly productId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly unit: string | null;
  readonly unitPriceMinor: number;
  readonly taxPercent: number;
  readonly totals: ReturnType<typeof lineTotals>;
}

@Injectable()
export class LineBuilderService {
  constructor(private readonly db: DbService) {}

  /**
   * Prices every line, filling the name, the unit price and the tax rate from the catalogue **only
   * where the caller omitted them**. That asymmetry is the whole convenience of picking a product,
   * and the reason a line still states what was agreed: once sent, the numbers are the document's.
   */
  async build(items: readonly LineItemRequest[]): Promise<BuiltLine[]> {
    const productIds = [
      ...new Set(items.map((item) => item.productId).filter((id): id is string => Boolean(id))),
    ];
    const products =
      productIds.length === 0
        ? []
        : await this.db.client.product.findMany({
            where: { id: { in: productIds }, deletedAt: null },
          });
    const byId = new Map(products.map((product) => [product.id, product]));

    const missing = productIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw AppError.notFound('Product');

    return items.map((item, index) => {
      const product = item.productId ? byId.get(item.productId) : undefined;
      const name = item.name ?? product?.name;
      const unitPriceMinor = item.unitPriceMinor ?? Number(product?.priceMinor ?? 0);
      const taxPercent = item.taxPercent ?? Number(product?.taxPercent ?? 0);
      if (!name) {
        throw AppError.validation('Some details need correcting', [
          { field: `items.${index}.name`, code: 'NAME_REQUIRED', message: 'Give the line a name.' },
        ]);
      }

      const input: LineItemInput = {
        quantity: item.quantity,
        unitPriceMinor,
        discountMinor: item.discountMinor,
        taxPercent,
      };
      let totals;
      try {
        totals = lineTotals(input);
      } catch (error) {
        // The shared arithmetic refuses impossible lines (a discount larger than the line, a
        // negative price); its message is already written for a person, so it is passed through
        // against the field the client sent rather than replaced with a generic one.
        if (error instanceof LineItemError) {
          throw AppError.validation('Some details need correcting', [
            {
              field: `items.${index}.${error.field}`,
              code: 'INVALID_LINE_ITEM',
              message: error.message,
            },
          ]);
        }
        throw error;
      }

      return {
        input,
        position: index + 1,
        productId: item.productId ?? null,
        name,
        description: item.description ?? null,
        unit: item.unit ?? product?.unit ?? null,
        unitPriceMinor,
        taxPercent,
        totals,
      };
    });
  }

  /**
   * Inserts the priced lines against their parent.
   *
   * `table` is `dealItem` or `quotationItem` and `parentColumn` is `dealId` or `quotationId`. The
   * two tables have identical columns deliberately, so one writer serves both and a column added to
   * one is a compile error if it is not added to the other.
   */
  async write(
    tx: TransactionClient,
    target: { table: 'dealItem' | 'quotationItem'; parentColumn: string; parentId: string },
    organizationId: string,
    lines: readonly BuiltLine[],
  ): Promise<void> {
    if (lines.length === 0) return;
    const data = lines.map((line) => ({
      id: newId(),
      organizationId,
      [target.parentColumn]: target.parentId,
      productId: line.productId,
      position: line.position,
      name: line.name,
      description: line.description,
      quantity: line.input.quantity,
      unit: line.unit,
      unitPriceMinor: BigInt(line.unitPriceMinor),
      discountMinor: BigInt(line.totals.discountMinor),
      taxPercent: line.taxPercent,
      grossMinor: BigInt(line.totals.grossMinor),
      netMinor: BigInt(line.totals.netMinor),
      taxMinor: BigInt(line.totals.taxMinor),
      totalMinor: BigInt(line.totals.totalMinor),
    }));

    if (target.table === 'dealItem') {
      await tx.dealItem.createMany({ data: data as never });
      return;
    }
    await tx.quotationItem.createMany({ data: data as never });
  }

  /**
   * The lines of an existing document, as a request — which is how a quotation is raised from a
   * deal and how a revision copies the version it replaces. Rebuilding from the stored row rather
   * than from the product is what makes "revise and change one line" not silently re-price the
   * other nine.
   */
  static asRequests(
    rows: readonly {
      productId: string | null;
      name: string;
      description: string | null;
      quantity: unknown;
      unit: string | null;
      unitPriceMinor: bigint;
      discountMinor: bigint;
      taxPercent: unknown;
    }[],
  ): LineItemRequest[] {
    return rows.map((row) => ({
      productId: row.productId,
      name: row.name,
      description: row.description,
      quantity: Number(row.quantity),
      unit: row.unit,
      unitPriceMinor: Number(row.unitPriceMinor),
      discountMinor: Number(row.discountMinor),
      taxPercent: Number(row.taxPercent),
    }));
  }
}
