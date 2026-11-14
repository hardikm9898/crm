/**
 * A problem with a piece of tenant-authored content, addressed at the field it belongs to.
 *
 * In its own module and under a name that is not about blocks, because two validators now return
 * it — `validateBlocks` and the SEO pair in `website-seo.ts` — and a second identical interface
 * beside the first is the duplication this codebase keeps paying for. Type-only, so no import
 * cycle is possible whichever module reaches for it.
 *
 * The `field` is a path a screen can match against a control it has rendered
 * (`blocks[2].params.heading`, `seo.description`), which is what makes a refusal printable **at
 * the row it names** rather than only as a summary. The mapping editor paid for the summary-only
 * version of this once: "that field mapping cannot be used", with the sentence somebody could act
 * on discarded.
 */
export interface ContentProblem {
  readonly field: string;
  readonly code:
    'UNKNOWN_TYPE' | 'UNKNOWN_KEY' | 'REQUIRED' | 'TOO_LONG' | 'NOT_A_LIST' | 'INVALID';
  readonly message: string;
}
