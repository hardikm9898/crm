import { describe, expect, it } from 'vitest';
import { CSV_CONTENT_TYPES } from './csv-body.js';
import { MEDIA_BODY_LIMIT, MEDIA_CONTENT_TYPES } from './media-body.js';

/**
 * The one thing about these lists that cannot be checked by reading them.
 *
 * A Fastify content-type parser is **global**, so two features cannot both register one: adding
 * `application/vnd.ms-excel` to the media list — which is what Excel calls a CSV, and which the
 * import already claims — made the whole application die at boot with
 * `Content type parser 'application/vnd.ms-excel' already present`. Every route gone, on a change
 * that type-checked and that no test touched. This spec is the guard.
 */
describe('the content types that may carry a raw body', () => {
  it('never claims a type another feature already parses', () => {
    const overlap = MEDIA_CONTENT_TYPES.filter((type) =>
      (CSV_CONTENT_TYPES as readonly string[]).includes(type),
    );
    expect(overlap).toEqual([]);
  });

  it('never claims `application/json`, which Nest registers itself', () => {
    expect(MEDIA_CONTENT_TYPES).not.toContain('application/json');
  });

  it('never claims `text/plain`', () => {
    // Too many clients default to it, and a parser for it would hand every one of them the 16 MB
    // limit on the one path that allows uploads.
    expect(MEDIA_CONTENT_TYPES).not.toContain('text/plain');
  });

  it('lists each type once, because a duplicate is the same boot failure', () => {
    expect([...new Set(MEDIA_CONTENT_TYPES)]).toHaveLength(MEDIA_CONTENT_TYPES.length);
  });

  it('is the same ceiling `MEDIA_LIMITS` enforces per kind', () => {
    expect(MEDIA_BODY_LIMIT).toBe(16 * 1024 * 1024);
  });
});
