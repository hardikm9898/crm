import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { newToken } from './ids.js';
import { isValidCustomFieldKey } from './custom-fields.js';

/**
 * The public ingestion API's vocabulary and its cryptography (`FR-CAP-1`, `FR-CAP-6`, `FR-CAP-7`,
 * `FR-API-5`).
 *
 * Everything here is pure, and all of it is reachable by somebody who is not a customer. That is
 * why the signature check, the key format and the dedupe hash live in one tested module rather than
 * inside the service: a signature verifier written twice is a signature verifier that disagrees
 * with itself, and the half that is wrong is the half an attacker uses.
 */

/** Where a payload came from. The channel is part of the idempotency key, so these are stable. */
export const INGEST_CHANNELS = [
  'public_api',
  'webhook',
  'meta_ads',
  'google_ads',
  'form',
  'whatsapp',
  'import',
] as const;
export type IngestChannel = (typeof INGEST_CHANNELS)[number];

/**
 * What became of a payload.
 *
 * `received` is the state it is written in — before anything has been attempted — which is what
 * makes this a never-lose store rather than a record of what worked (`FR-CAP-3`).
 */
export const INBOUND_STATUSES = ['received', 'processed', 'duplicate', 'failed'] as const;
export type InboundStatus = (typeof INBOUND_STATUSES)[number];

/**
 * The step of the pipeline a failure happened in (`FR-CAP-4`'s own list).
 *
 * Recorded per error so "why did my lead not appear" has an answer that names a stage rather than
 * a stack trace: a tenant can act on "normalize — that phone number has no country code" and can
 * do nothing at all with `PrismaClientKnownRequestError`.
 */
export const INGESTION_STAGES = [
  'authenticate',
  'validate',
  'normalize',
  'duplicate_check',
  'persist',
  'assign',
  'notify',
] as const;
export type IngestionStage = (typeof INGESTION_STAGES)[number];

/**
 * What a key may do.
 *
 * Deliberately two, both of which this step actually uses: writing a capture, and reading back what
 * the key itself has sent. The authenticated REST surface (`FR-API-1`) arrives with its own step and
 * will add the scopes it needs; inventing them now would be a list nothing enforces.
 */
export const API_KEY_SCOPES = ['ingest:write', 'ingest:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** How long a signed request stays valid. Five minutes each way, the usual webhook tolerance. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The public half of a key pair, as it appears in a header and in the screen that lists keys. */
export interface GeneratedApiKey {
  /** `pk_live_…` — identifies the key. Not a secret, and stored in full. */
  readonly keyId: string;
  /** `sk_live_…` — signs requests. Encrypted at rest (an HMAC needs it) and shown once (`FR-CAP-7`). */
  readonly secret: string;
  /** The first characters of the id, for "which key is this" on a screen and in a log. */
  readonly prefix: string;
}

/**
 * A new key pair.
 *
 * Prefixed `pk_`/`sk_` so a secret pasted into a bug report is recognisable as one — the convention
 * every secret scanner already knows — and `live` because a test-mode key is a later decision, not
 * one to pretend to have made.
 */
export function generateApiKey(): GeneratedApiKey {
  const keyId = `pk_live_${newToken(12)}`;
  return { keyId, secret: `sk_live_${newToken(24)}`, prefix: keyId.slice(0, 16) };
}

/**
 * There is deliberately **no** `hashApiSecret` here.
 *
 * The first draft had one, and it could not work: this API verifies an HMAC the caller computed
 * with the secret, and an HMAC cannot be checked against a digest — a receiver of signed requests
 * has to hold the shared secret. So the secret is stored encrypted (AES-256-GCM, the key's own id
 * as AAD) rather than hashed, and the trade-off is written down in ADR-0030 instead of being
 * papered over with a hash that nothing could use.
 */

/**
 * The string a signature is computed over: `"<timestamp>.<raw body>"`.
 *
 * The **raw** body, byte for byte, never a re-serialised object: `{"a":1}` and `{ "a": 1 }` are the
 * same object and different bytes, and a verifier that re-serialises would reject every client
 * whose JSON writer disagrees with ours.
 */
export function signaturePayload(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** The header a client sends: `t=<unix seconds>,v1=<hex hmac>`. */
export function signRequest(secret: string, timestamp: number, rawBody: string): string {
  const mac = createHmac('sha256', secret)
    .update(signaturePayload(timestamp, rawBody))
    .digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export type SignatureFailure = 'missing' | 'malformed' | 'stale' | 'mismatch';

export interface SignatureCheck {
  readonly ok: boolean;
  readonly failure?: SignatureFailure;
}

/**
 * Verifies a signature header against the raw body.
 *
 * Four refusals, kept apart because they mean different things to whoever is integrating: no header
 * at all, a header that is not the documented shape, a timestamp outside the window (a replay, or a
 * clock nobody has set), and a digest that does not match (the wrong secret, or a modified body).
 * The comparison is timing-safe, and the timestamp is checked **before** the digest so a replay
 * costs an attacker no information about the secret.
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  rawBody: string,
  now: Date = new Date(),
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): SignatureCheck {
  if (header === undefined || header.trim() === '') return { ok: false, failure: 'missing' };

  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const index = piece.indexOf('=');
    if (index <= 0) continue;
    parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }
  const timestamp = Number(parts.get('t'));
  const presented = parts.get('v1');
  if (!Number.isFinite(timestamp) || timestamp <= 0 || presented === undefined) {
    return { ok: false, failure: 'malformed' };
  }
  if (!/^[0-9a-f]{64}$/.test(presented)) return { ok: false, failure: 'malformed' };

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  if (skew > toleranceSeconds) return { ok: false, failure: 'stale' };

  const expected = createHmac('sha256', secret)
    .update(signaturePayload(timestamp, rawBody))
    .digest('hex');
  const matches = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'));
  return matches ? { ok: true } : { ok: false, failure: 'mismatch' };
}

/**
 * The idempotency key a payload gets when the client did not supply one.
 *
 * `FR-CAP-6` says "idempotent on a client-supplied **or derived** key", and the derived one has to
 * be a hash of the body: a retry of the same enquiry is the same bytes, and two different enquiries
 * that happen to arrive together are not. Prefixed so a derived key is never mistaken for one a
 * client chose — which matters when somebody asks why their two deliberate submissions collapsed
 * into one.
 */
export function derivedIdempotencyKey(channel: string, rawBody: string): string {
  return `derived_${createHash('sha256').update(`${channel}:${rawBody}`).digest('hex').slice(0, 40)}`;
}

/** The fingerprint stored beside a payload, so two identical bodies are recognisable as such. */
export function dedupeHash(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * `Priya Sharma Nair` → first `Priya Sharma`, last `Nair`; a single word is a first name.
 *
 * **One** definition, in this package, because three channels now split a name: the import (where
 * it was written), a capture form, and the public API. The form's first draft took the *first* word
 * as the given name and the rest as the surname — the same person's name split two ways depending
 * on which door they came in through, and the kind of divergence nothing fails on.
 */
export function splitFullName(value: string): { firstName: string; lastName: string | null } {
  const parts = value
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  if (parts.length <= 1) return { firstName: parts[0] ?? '', lastName: null };
  const lastName = parts.pop() as string;
  return { firstName: parts.join(' '), lastName };
}

/** The lead fields the public API accepts by name, and what each one means on a lead. */
export const PUBLIC_LEAD_FIELDS = [
  'name',
  'firstName',
  'lastName',
  'company',
  'jobTitle',
  'phone',
  'whatsapp',
  'email',
  'city',
  'state',
  'country',
  'postalCode',
  'valueMinor',
  'message',
  'source',
  'formSlug',
  'customFields',
  'utm',
  'pageUrl',
  'referrer',
  'visitorId',
  'sessionId',
  'consent',
  'metadata',
  'capturedAt',
] as const;

/**
 * The keys of a payload that are not fields this API knows (`FR-CAP-5`).
 *
 * Reported rather than refused, and reported **by name**: "we kept 3 fields we do not understand"
 * is useless, and `propertyType`, `budget_band`, `agent_code` is a list somebody can turn into
 * three custom fields in a minute.
 */
export function unmappedKeys(body: Readonly<Record<string, unknown>>): string[] {
  const known = new Set<string>(PUBLIC_LEAD_FIELDS);
  return Object.keys(body).filter((key) => !known.has(key));
}

/**
 * The custom field key a payload's extra key would become (`FR-CAP-5`).
 *
 * One definition, read by three places: the web app's "make this a field" button fills its key box
 * from it, this package's spec reconciles the web app's hand-written copy against it, and the
 * **mapper** matches an integration's top-level key against the workspace's definitions with it —
 * which is what makes the one click worth clicking. Without that last use, somebody turns
 * `propertyType` into a field and the next payload still does not fill it in: a feature that looks
 * built and is not.
 *
 * `null` when nothing valid can be derived — a reserved name, or a key that cannot start where it
 * starts. Offering a button that is certain to be refused is worse than offering none.
 */
export function customFieldKeyFor(payloadKey: string): string | null {
  const key = payloadKey
    .trim()
    // Before lowercasing, or `propertyType` loses its word boundary and becomes `propertytype`.
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .slice(0, 49);
  return isValidCustomFieldKey(key) ? key : null;
}
