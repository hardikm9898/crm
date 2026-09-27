import { describe, expect, it } from 'vitest';
import { idTimestamp, isUuid, newId, newToken } from './ids.js';

describe('newId (UUIDv7)', () => {
  it('produces a valid v7 uuid', () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
  });

  it('is monotonically sortable across milliseconds', () => {
    const early = newId(1_700_000_000_000);
    const later = newId(1_700_000_001_000);
    expect(early < later).toBe(true);
  });

  it('embeds the generation timestamp', () => {
    const when = 1_759_000_000_000;
    expect(idTimestamp(newId(when))?.getTime()).toBe(when);
  });

  it('does not collide across many generations', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => newId()));
    expect(ids.size).toBe(5_000);
  });

  it('rejects non-uuid strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('newToken', () => {
  it('is url-safe and unique', () => {
    const tokens = Array.from({ length: 100 }, () => newToken());
    expect(new Set(tokens).size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
