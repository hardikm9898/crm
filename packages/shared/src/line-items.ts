/**
 * The arithmetic of a priced line, and of the document it sits on.
 *
 * Pure, and in `@leados/shared`, because three things will compute it and they must never disagree:
 * a deal's value, a quotation's totals, and the PDF a customer receives. A quotation that says
 * ₹1,18,000 and an invoice that says ₹1,17,999 is the kind of discrepancy that ends a sale.
 *
 * **Everything is minor units and integers.** No floating point touches money. Quantity is the only
 * fractional input (2.5 hours, 1.75 kg), so it is the one place rounding happens, and it happens
 * once per line — never on a running total, which is what makes the sum of the lines equal the
 * document total exactly.
 *
 * **Tax is per line, not per document.** In India a single quotation routinely mixes 5%, 12% and 18%
 * GST, and a document-level rate cannot express that. The tax *breakdown* is then grouped by rate,
 * because that is what a tax invoice has to show.
 */

export interface LineItemInput {
  /** Fractional quantities are real: 2.5 hours, 1.75 kg. Up to three decimal places. */
  readonly quantity: number;
  readonly unitPriceMinor: number;
  /** An absolute amount off this line, in minor units — never a percentage. See `discountMinor`. */
  readonly discountMinor?: number;
  /** 0, 5, 12, 18, 28 — whatever this tenant charges. Up to two decimal places. */
  readonly taxPercent?: number;
}

export interface LineItemTotals {
  /** `quantity × unitPrice`, rounded to the currency's minor unit. */
  readonly grossMinor: number;
  readonly discountMinor: number;
  /** Gross less discount — what tax is charged on. */
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

export interface DocumentTotals {
  readonly grossMinor: number;
  readonly discountMinor: number;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  /** One entry per distinct tax rate, which is what a tax invoice has to print. */
  readonly taxBreakdown: readonly { readonly percent: number; readonly taxMinor: number }[];
}

/** The largest quantity a line may carry. Beyond this the integer arithmetic stops being exact. */
export const MAX_QUANTITY = 1_000_000;
/** Three decimal places on quantity, two on a tax rate — the precision real documents use. */
export const QUANTITY_SCALE = 1_000;
export const TAX_PERCENT_SCALE = 100;

export class LineItemError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'LineItemError';
  }
}

/**
 * One line.
 *
 * Quantity is scaled to an integer before multiplying, so `0.1 × 3` cannot become `0.30000000000004`
 * and a line of 2.5 × ₹199.99 is exactly ₹499.98 rather than a cent adrift.
 */
export function lineTotals(input: LineItemInput): LineItemTotals {
  const quantity = requireFinite(input.quantity, 'quantity');
  if (quantity < 0) throw new LineItemError('quantity', 'A quantity cannot be negative.');
  if (quantity > MAX_QUANTITY) {
    throw new LineItemError('quantity', `A quantity cannot exceed ${MAX_QUANTITY}.`);
  }
  const unitPriceMinor = requireInteger(input.unitPriceMinor, 'unitPriceMinor');
  if (unitPriceMinor < 0) throw new LineItemError('unitPriceMinor', 'A price cannot be negative.');

  const discountMinor = requireInteger(input.discountMinor ?? 0, 'discountMinor');
  if (discountMinor < 0) throw new LineItemError('discountMinor', 'A discount cannot be negative.');

  const taxPercent = requireFinite(input.taxPercent ?? 0, 'taxPercent');
  if (taxPercent < 0 || taxPercent > 100) {
    throw new LineItemError('taxPercent', 'A tax rate must be between 0 and 100.');
  }

  // Scaled integers throughout: the only rounding is this one, on the line's gross.
  const scaledQuantity = Math.round(quantity * QUANTITY_SCALE);
  const grossMinor = Math.round((scaledQuantity * unitPriceMinor) / QUANTITY_SCALE);
  if (discountMinor > grossMinor) {
    throw new LineItemError(
      'discountMinor',
      'A discount cannot be larger than the line it is taken off.',
    );
  }

  const netMinor = grossMinor - discountMinor;
  const scaledTax = Math.round(taxPercent * TAX_PERCENT_SCALE);
  const taxMinor = Math.round((netMinor * scaledTax) / (100 * TAX_PERCENT_SCALE));

  return { grossMinor, discountMinor, netMinor, taxMinor, totalMinor: netMinor + taxMinor };
}

/**
 * The document.
 *
 * Totals are the **sum of the already-rounded lines**, never a recomputation from the raw inputs.
 * The two differ by a unit or two on a long document, and the sum is the one a customer can check
 * by adding up the column in front of them — which is the only definition of "correct" that
 * matters when somebody disputes an invoice.
 */
export function documentTotals(items: readonly LineItemInput[]): DocumentTotals {
  const byRate = new Map<number, number>();
  let grossMinor = 0;
  let discountMinor = 0;
  let netMinor = 0;
  let taxMinor = 0;

  for (const item of items) {
    const line = lineTotals(item);
    grossMinor += line.grossMinor;
    discountMinor += line.discountMinor;
    netMinor += line.netMinor;
    taxMinor += line.taxMinor;
    const percent = item.taxPercent ?? 0;
    byRate.set(percent, (byRate.get(percent) ?? 0) + line.taxMinor);
  }

  return {
    grossMinor,
    discountMinor,
    netMinor,
    taxMinor,
    totalMinor: netMinor + taxMinor,
    taxBreakdown: [...byRate.entries()]
      // Zero-rated lines are not a tax line on an invoice, but a 0% *rate* with a nonzero total is
      // impossible — so dropping the zero entry is dropping nothing a document should print.
      .filter(([, amount]) => amount !== 0)
      .sort((a, b) => a[0] - b[0])
      .map(([percent, amount]) => ({ percent, taxMinor: amount })),
  };
}

/**
 * The weighted value of a deal: what to expect, not what to hope for.
 *
 * A pipeline report that adds up full deal values tells a business owner they are about to receive
 * money that is still a conversation. Probability comes from the stage, so this is the figure the
 * stage itself implies.
 */
export function weightedValueMinor(valueMinor: number, probability: number): number {
  if (probability <= 0) return 0;
  if (probability >= 100) return valueMinor;
  return Math.round((valueMinor * probability) / 100);
}

function requireFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LineItemError(field, 'That is not a number.');
  }
  return value;
}

function requireInteger(value: number, field: string): number {
  const checked = requireFinite(value, field);
  if (!Number.isInteger(checked)) {
    throw new LineItemError(field, 'That must be a whole number of paise, cents or fils.');
  }
  return checked;
}
