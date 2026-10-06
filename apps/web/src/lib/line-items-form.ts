/**
 * Reading a line-items table out of a submitted form, once.
 *
 * A deal and a quotation are edited by the same table, so they are parsed by the same function —
 * the browser-side twin of `LineBuilderService` on the API, and for the same reason. Two copies of
 * this would eventually disagree about whether a blank row is a line, or which index a bad quantity
 * is reported against, and the one that disagreed would be the one somebody was looking at.
 */
const MINOR_UNITS = 100;

/**
 * Money arrives as rupees and leaves as paise.
 *
 * Returns `null` for "not given" and `NaN` for "given but unreadable", which the callers must tell
 * apart: an absent price means "take the catalogue's", and `12,5O,000` with a letter in it means
 * refuse the form rather than silently send a zero.
 */
export function parseAmountMinor(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  // Grouping separators and a rupee sign are how people write money; the rest must be a number.
  const cleaned = value.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * MINOR_UNITS);
}

/** Minor units as a plain decimal string, for putting back into an input. */
export function rupees(minor: number): string {
  return (minor / MINOR_UNITS).toFixed(2).replace(/\.00$/, '');
}

export interface ParsedLines {
  readonly items: Record<string, unknown>[];
  readonly fieldErrors: Record<string, string>;
}

/**
 * The table's rows, as the API's `items` array.
 *
 * A row with nothing in it is skipped rather than refused: the editor always offers one empty row,
 * and making somebody delete it before they can save would be a form arguing with itself. A row
 * with *something* in it must be complete.
 */
export function parseLineItems(form: FormData): ParsedLines {
  const names = form.getAll('line-name').map(String);
  const productIds = form.getAll('line-productId').map(String);
  const quantities = form.getAll('line-quantity').map(String);
  const prices = form.getAll('line-price').map(String);
  const discounts = form.getAll('line-discount').map(String);
  const taxes = form.getAll('line-tax').map(String);

  const items: Record<string, unknown>[] = [];
  const fieldErrors: Record<string, string> = {};

  for (let index = 0; index < names.length; index += 1) {
    const name = (names[index] ?? '').trim();
    const productId = (productIds[index] ?? '').trim();
    const quantityText = (quantities[index] ?? '').trim();
    if (name === '' && productId === '' && quantityText === '') continue;

    const quantity = Number(quantityText);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      fieldErrors[`line-quantity-${index}`] = 'Enter a quantity greater than zero.';
      continue;
    }
    const price = parseAmountMinor(prices[index]);
    const discount = parseAmountMinor(discounts[index]);
    if (Number.isNaN(price) || Number.isNaN(discount)) {
      fieldErrors[`line-price-${index}`] = 'Enter an amount, like 5000 or 5,000.';
      continue;
    }

    items.push({
      ...(productId ? { productId } : {}),
      ...(name ? { name } : {}),
      quantity,
      ...(price === null ? {} : { unitPriceMinor: price }),
      discountMinor: discount ?? 0,
      ...(taxes[index] && taxes[index] !== '' ? { taxPercent: Number(taxes[index]) } : {}),
    });
  }

  return { items, fieldErrors };
}
