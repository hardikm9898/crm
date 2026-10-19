import { createHash } from 'node:crypto';

/**
 * A stable timeline event id, from whatever the provider calls the thing.
 *
 * The timeline deduplicates on `(organization_id, source_event_id, occurred_at)` and the column is
 * a uuid, so a `wamid` cannot be it. What is needed is only that the same event always produces the
 * same uuid, which a hash gives — so a replayed job writes no second row.
 *
 * In its own file because two services need it and an import between them would be an ESM cycle:
 * the one that is a `ReferenceError` at boot, with nothing in either file looking wrong.
 */
export function deterministicEventId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    // Version 8: a uuid whose bits are ours to choose, which is exactly what this is.
    `8${digest.slice(13, 16)}`,
    ((parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') +
      digest.slice(18, 20),
    digest.slice(20, 32),
  ].join('-');
}
