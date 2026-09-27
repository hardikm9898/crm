/**
 * Result type for operations whose failure is an expected outcome rather than an
 * exception — bulk row processing, ingestion steps, provider calls. Keeps partial
 * success expressible (docs/api-architecture.md §3, "Partial success").
 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Splits a batch of results into successes and failures for a partial-success response. */
export function partition<T, E>(
  results: readonly Result<T, E>[],
): {
  succeeded: T[];
  failed: E[];
} {
  const succeeded: T[] = [];
  const failed: E[] = [];
  for (const result of results) {
    if (result.ok) succeeded.push(result.value);
    else failed.push(result.error);
  }
  return { succeeded, failed };
}
