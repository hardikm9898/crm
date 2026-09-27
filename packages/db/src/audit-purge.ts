import type { UnscopedDbClient } from './client.js';

/**
 * The only sanctioned way to delete audit rows.
 *
 * `audit_logs` is append-only at the database level (FR-AUD-2), so history cannot be
 * rewritten by application code, a compromised account, or a careless cascade. Erasure
 * is still required by retention policies and data-subject requests (FR-PRV-3), so the
 * trigger permits DELETE only inside a transaction that has explicitly opted in.
 *
 * Every use must itself be recorded — the caller writes an audit entry describing what
 * was purged and under which policy, before the rows go.
 */
export async function withAuditPurge<T>(
  db: UnscopedDbClient,
  reason: string,
  fn: (tx: Parameters<Parameters<UnscopedDbClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (reason.trim().length === 0) {
    throw new Error('withAuditPurge requires a reason (retention policy or DSR reference)');
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.audit_purge = 'on'`);
    return fn(tx);
  });
}
