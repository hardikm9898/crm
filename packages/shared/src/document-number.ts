/**
 * Rendering a document number from a workspace's series (`FR-DEAL-2`).
 *
 * A quotation number is read aloud on the phone and typed into a bank transfer reference, so it has
 * to be short and stable: `QTN-0007`, never a UUID. The allocation — advancing the counter under a
 * row lock — belongs to the database; this is only the rendering, which is here because the API,
 * the PDF and the settings preview must all produce the same string from the same series.
 */
export interface DocumentNumberSeries {
  /** "QTN-", "Q/2026/", or empty. Whatever the tenant decided; nothing is appended for them. */
  readonly prefix: string;
  /** Zero-padding width. `4` renders 7 as `0007`; `0` renders it as `7`. */
  readonly padding: number;
}

export const MAX_NUMBER_PADDING = 12;

/**
 * The number a document gets, given its series and the counter value it was allocated.
 *
 * A value longer than the padding is **not** truncated — the 10 000th quotation of a workspace with
 * four-digit padding is `QTN-10000`, not `QTN-0000`. Silently reusing numbers once a counter
 * overflows its padding would collide on `(organization_id, number, version)` and, worse, give two
 * customers the same reference.
 */
export function formatDocumentNumber(series: DocumentNumberSeries, value: number): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`A document number must be a positive integer, got ${value}`);
  }
  const padding = Math.min(Math.max(Math.trunc(series.padding), 0), MAX_NUMBER_PADDING);
  return `${series.prefix}${String(value).padStart(padding, '0')}`;
}

/** What the next number will look like, for a settings screen that is about to change the series. */
export function previewDocumentNumber(series: DocumentNumberSeries, nextValue: number): string {
  return formatDocumentNumber(series, nextValue);
}
