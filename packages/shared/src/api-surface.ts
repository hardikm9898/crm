import { PERMISSIONS, type Permission } from './rbac.js';

/**
 * The authenticated REST surface's vocabulary (`FR-API-1`, `FR-SA-4`).
 *
 * Step 2 built the one public endpoint a stranger's server posts a lead to. This is the surface a
 * program uses to *read and change* what is already in the workspace — the same routes the web app
 * calls, reached with a key instead of a session — and the request log that makes an integration
 * debuggable from the outside.
 *
 * Pure, and tested on its own, for the reason the ingestion module gives: a credential parser or a
 * scope rule written twice is one that disagrees with itself, and the half that is wrong is the
 * half somebody's integration runs into.
 */

/**
 * The public ingestion surface's own scopes, from step 2. Not permission keys: nothing in the
 * permission catalogue describes "may post to the public endpoint", because no member ever does.
 */
export const INGESTION_SCOPES = ['ingest:write', 'ingest:read'] as const;
export type IngestionScope = (typeof INGESTION_SCOPES)[number];

const P = PERMISSIONS;

/**
 * The permissions a key may be granted, and the decision this list *is*.
 *
 * A key's scopes are **permission keys**, enforced by the permission guard every route already
 * declares — so a key reaching `GET /leads` is checked against `lead:read` by the same code that
 * checks a person, and a route added next year is covered without touching this file. The
 * alternative, a coarse `leads:read` scope expanded through a mapping table, is a second
 * description of the same fact that drifts from the first the day a permission is added.
 *
 * What is **not** here is the point: a key cannot administer access (`role:manage`, `user:manage`,
 * `api_key:manage`), money (`billing:manage`), the credential surface itself (`webhook:manage`),
 * the workspace's identity (`organization:manage`) or privacy requests (`privacy:manage`), and it
 * cannot export the personal data a person has to tick a box to see (`export:pii`). A key lives in
 * a config file on somebody else's server; a key that can mint roles is a privilege escalation
 * left lying about, and "the integration needed it" is how that happens. Those actions stay with a
 * person holding a session, which is also what makes them auditable to a human being.
 */
export const API_GRANTABLE_PERMISSIONS: readonly Permission[] = [
  P.ORGANIZATION_READ,
  P.USER_READ,
  P.ROLE_READ,
  P.SETTINGS_READ,
  P.LEAD_READ,
  P.LEAD_CREATE,
  P.LEAD_UPDATE,
  P.LEAD_ASSIGN,
  P.CUSTOMER_READ,
  P.CUSTOMER_MANAGE,
  P.TASK_READ,
  P.TASK_MANAGE,
  P.SLA_READ,
  P.DEAL_READ,
  P.DEAL_MANAGE,
  P.CALL_READ,
  P.CALL_LOG,
  P.PAYMENT_READ,
  P.FORM_READ,
  P.REPORT_READ,
  P.EXPORT_DATA,
] as const;

/**
 * Everything a key's `scopes` column may contain: the ingestion scopes, then permission keys.
 *
 * Two vocabularies in one column, with a stated grammar rather than a guess — the column is "what
 * this credential may do", and the two surfaces it reaches describe that differently. One function
 * decides whether an entry is valid, so there is still only one reader.
 */
export const API_KEY_SCOPES = [...INGESTION_SCOPES, ...API_GRANTABLE_PERMISSIONS] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

export function isIngestionScope(value: string): value is IngestionScope {
  return (INGESTION_SCOPES as readonly string[]).includes(value);
}

/** The permission keys among a key's scopes — what the REST surface enforces. */
export function restPermissionsOf(scopes: readonly string[]): Permission[] {
  return scopes.filter(
    (scope): scope is Permission =>
      !isIngestionScope(scope) && (API_GRANTABLE_PERMISSIONS as readonly string[]).includes(scope),
  );
}

/**
 * How a key is presented on the REST surface: `Authorization: Bearer <keyId>.<secret>`.
 *
 * One header, and one way to do it. The public ingestion endpoint signs each request with an HMAC
 * because a capture is a replayable write arriving from a position we do not trust, and because the
 * body is the thing that must be bound to the signature. A general REST API is different: a
 * signature that does not also cover the method and the path lets a captured `GET /leads` signature
 * be replayed as a `DELETE` inside the tolerance window, so a signed REST surface would need its
 * *own* construction — a second scheme every client library has to implement by hand, for a
 * property TLS already provides. A bearer secret over TLS is the convention every integrator
 * already has code for, and the secret is 24 random bytes rather than a password.
 *
 * The id half is what makes it one header: it is the lookup, so nothing else has to be sent.
 */
export const API_CREDENTIAL_SEPARATOR = '.';

export type CredentialFailure = 'missing' | 'malformed';

export interface ParsedCredential {
  readonly keyId: string;
  readonly secret: string;
}

export function parseApiCredential(
  header: string | undefined,
): { ok: true; credential: ParsedCredential } | { ok: false; failure: CredentialFailure } {
  const value = bearerValue(header);
  if (value === null) return { ok: false, failure: 'missing' };
  const cut = value.indexOf(API_CREDENTIAL_SEPARATOR);
  if (cut <= 0) return { ok: false, failure: 'malformed' };
  const keyId = value.slice(0, cut);
  const secret = value.slice(cut + 1);
  if (!keyId.startsWith('pk_') || !secret.startsWith('sk_')) {
    return { ok: false, failure: 'malformed' };
  }
  return { ok: true, credential: { keyId, secret } };
}

/**
 * Whether a bearer value is an API credential rather than an access token.
 *
 * The two share the header, so something has to tell them apart. The key id's `pk_` prefix does:
 * a JWT is three base64url segments split by dots and cannot begin with it. Deciding by *shape*
 * rather than by trying one and falling back to the other matters for the answer a caller gets —
 * a mistyped key should be refused as a bad key, not as an expired session.
 */
export function looksLikeApiCredential(header: string | undefined): boolean {
  return bearerValue(header)?.startsWith('pk_') === true;
}

function bearerValue(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

/** Why a credential was refused, in words an integrator can act on. */
export function credentialMessage(failure: CredentialFailure): string {
  return failure === 'missing'
    ? 'This endpoint needs a credential. Send Authorization: Bearer <key id>.<secret>, or sign in.'
    : 'That credential is not in the documented form: Authorization: Bearer pk_live_….sk_live_….';
}

/**
 * How long a request log is kept.
 *
 * Thirty days: long enough to answer "what did my integration send last month's invoice run", short
 * enough that the table stays a debugging tool rather than a second copy of the product's data. The
 * rows are dropped a whole daily partition at a time, which is the only deletion of a million rows
 * that costs nothing.
 */
export const API_LOG_RETENTION_DAYS = 30;

/** How many days of partitions the maintenance job keeps ahead of today. */
export const API_LOG_PARTITION_DAYS_AHEAD = 7;

/**
 * What is written per request, and — just as deliberately — what is not.
 *
 * **The query string is not stored.** The filter DSL carries names, phone numbers and amounts, and
 * this log is readable by anybody holding `api_key:manage` rather than by somebody holding
 * `lead:read`. The path alone answers "which endpoint", which is the question the log exists for;
 * the body is never stored for the same reason, one step more obvious.
 */
export function logPath(url: string): string {
  const cut = url.indexOf('?');
  const path = cut === -1 ? url : url.slice(0, cut);
  return path.length > 512 ? path.slice(0, 512) : path;
}

/** The status families a screen groups by: 2xx, 4xx the caller can fix, 5xx we must. */
export type StatusClass = 'success' | 'client_error' | 'server_error' | 'other';

export function statusClass(status: number): StatusClass {
  if (status >= 200 && status < 400) return 'success';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'other';
}

/** A duration in words, for a screen: `120 ms`, `1.4 s`. */
export function describeDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
