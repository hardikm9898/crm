/**
 * File storage, behind a port so the driver is swappable
 * (`docs/integration-architecture.md` §2, `docs/deployment-architecture.md` §3).
 *
 * The contract is deliberately small — put, get, remove, a signed-ish URL — because that is all
 * imports, exports and (later) lead attachments need, and because every method here has to be
 * implementable by both a local directory and an S3-compatible bucket without one of them lying.
 *
 * Two things are *not* in the contract, on purpose:
 *
 *  * **Listing.** Nothing above the port may enumerate a bucket: the `documents` table is the
 *    index, and it is tenant-scoped. A driver-level listing would be the one read path that
 *    crosses tenants.
 *  * **Public URLs.** `urlFor` returns a link the *API* serves, not one the bucket serves, so
 *    authorization is always checked by us. A pre-signed S3 URL is an optimisation the S3 driver
 *    may add later; the port does not promise one, and no caller may assume the bytes are
 *    reachable without a permission check.
 */
export interface StoredObject {
  /** The driver's key. Opaque above the port — only the driver interprets it. */
  readonly key: string;
  readonly sizeBytes: number;
  /** SHA-256, hex. Computed by the port so every caller records the same thing. */
  readonly checksum: string;
}

export interface PutObjectInput {
  /**
   * The key, built by the caller through `documentKey()` so the layout is one decision in one
   * place. Must be a relative, `/`-separated path with no `.` or `..` segment: the local driver
   * resolves it against a root directory and a `..` would escape it.
   */
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

export interface StoragePort {
  /** Writes (or overwrites) an object and reports what was written. */
  put(input: PutObjectInput): Promise<StoredObject>;
  /** The bytes, or `null` when the object is not there — a missing file is an expected state. */
  get(key: string): Promise<Buffer | null>;
  /** Removes the bytes. Idempotent: removing what is already gone succeeds. */
  remove(key: string): Promise<void>;
  /** Which driver is in use, for the health endpoint and the operator console. */
  readonly driver: string;
}

export const STORAGE = Symbol('STORAGE');

/** Key segments may not contain a separator, a traversal, or a leading dot. */
const UNSAFE_SEGMENT = /^$|^\.+$|[/\\]/;

export class StorageKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Unsafe storage key ${JSON.stringify(key)}: ${reason}`);
    this.name = 'StorageKeyError';
  }
}

/**
 * Validates a key the way every driver needs it validated, so the check cannot be present in one
 * driver and missing in another.
 */
export function assertSafeKey(key: string): void {
  if (key === '') throw new StorageKeyError(key, 'empty');
  if (key.startsWith('/')) throw new StorageKeyError(key, 'absolute');
  if (key.includes('\0')) throw new StorageKeyError(key, 'contains a null byte');
  for (const segment of key.split('/')) {
    if (UNSAFE_SEGMENT.test(segment)) {
      throw new StorageKeyError(key, `segment ${JSON.stringify(segment)} is not a plain name`);
    }
  }
}

/**
 * The object layout: `org/<organizationId>/<subject>/<yyyy-mm>/<id>-<safe name>`.
 *
 * Tenant-first because that is the prefix an operator deletes when a workspace is purged, and
 * because an S3 lifecycle rule or a bucket policy can be written per tenant. The month folder
 * keeps a directory listing on the local driver survivable; the id keeps two uploads of
 * `leads.csv` from colliding. The original name is kept (sanitised) so an operator looking at the
 * bucket can tell what a file is.
 */
export function documentKey(input: {
  readonly organizationId: string;
  readonly subject: string;
  readonly documentId: string;
  readonly fileName: string;
  readonly at?: Date;
}): string {
  const at = input.at ?? new Date();
  const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = [
    'org',
    input.organizationId,
    safeSegment(input.subject),
    month,
    `${input.documentId}-${safeFileName(input.fileName)}`,
  ].join('/');
  assertSafeKey(key);
  return key;
}

/** Everything that is not a plain name character becomes a dash. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return cleaned === '' ? 'file' : cleaned;
}

/**
 * A stored file name is derived from the upload's, never used as given: a name is attacker-supplied
 * text that ends up on a filesystem. Length is capped so the whole key stays well inside the
 * 1 024-byte S3 key limit and a local filesystem's 255-byte name limit.
 */
export function safeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  return safeSegment(base).slice(0, 96);
}
