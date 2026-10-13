/**
 * The oversight screen's period windows (brief §4).
 *
 * Here rather than in the API because three places have to agree: the query schema that validates
 * `?days=`, the screen's period tabs, and the sentence each card writes about "the last N days". A
 * fourth window added in one of them is a tab that answers 400.
 *
 * A fixed set rather than a free `from`/`to` on purpose: every number on that screen is a live
 * aggregate over the whole set, and an arbitrary range is how somebody asks for two years of it by
 * accident. Arbitrary ranges belong with the rollup tables (ADR-0010), in Phase 10.
 */
export const OVERSIGHT_WINDOWS = [7, 30, 90] as const;
export type OversightWindow = (typeof OVERSIGHT_WINDOWS)[number];

export function isOversightWindow(value: number): value is OversightWindow {
  return (OVERSIGHT_WINDOWS as readonly number[]).includes(value);
}
