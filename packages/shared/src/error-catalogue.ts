import type { ErrorCode } from './errors.js';

/**
 * Every error code, with the status it carries and what a client should do about it
 * (`FR-API-3`, `docs/api-architecture.md` §2).
 *
 * `ErrorCode` is a union, which is exactly what a developer reading the published docs cannot
 * see: a list of twenty-five strings with no statuses and no advice. This is the runtime
 * catalogue the errors page is rendered from, and it is a `Record<ErrorCode, …>` on purpose —
 * adding a code to the union without describing it stops compiling, which is the only way a
 * published error list stays complete.
 *
 * `retry` is the thing most often got wrong by a client: a 429 should be retried after the hint,
 * a 409 should not be retried at all until the client has read the current state, and a 5xx from
 * a provider is somebody else's outage.
 */
export interface ErrorDefinition {
  readonly status: number;
  /** What happened, in a sentence a developer who did not write this API can act on. */
  readonly meaning: string;
  /** The next step. Not "contact support" unless that is genuinely the next step. */
  readonly whatToDo: string;
  readonly retry: 'never' | 'after-fixing' | 'with-backoff';
}

export const ERROR_CATALOGUE: Record<ErrorCode, ErrorDefinition> = {
  VALIDATION_FAILED: {
    status: 400,
    meaning: 'The request body or query did not match the endpoint’s schema.',
    whatToDo: 'Read `error.details`: it names the field, the rule and a message per problem.',
    retry: 'after-fixing',
  },
  INVALID_PHONE: {
    status: 400,
    meaning: 'A phone number could not be read as a number in the workspace’s country.',
    whatToDo: 'Send it in international form (+91…), or set the workspace’s default country.',
    retry: 'after-fixing',
  },
  INVALID_CUSTOM_FIELD: {
    status: 400,
    meaning: 'A custom field’s value did not match its definition — the type, or its options.',
    whatToDo: 'Read the definition from `GET /custom-fields` and send the value it describes.',
    retry: 'after-fixing',
  },
  UNKNOWN_FIELD: {
    status: 400,
    meaning: 'A field was sent that this endpoint does not accept.',
    whatToDo:
      'Remove it, or — on the public capture endpoint — leave it: unknown fields are kept there and surfaced for mapping.',
    retry: 'after-fixing',
  },
  UNAUTHENTICATED: {
    status: 401,
    meaning: 'No credential was presented, or the access token has expired.',
    whatToDo:
      'Send `Authorization: Bearer <key id>.<secret>` for a key, or refresh the session’s token.',
    retry: 'after-fixing',
  },
  TOKEN_EXPIRED: {
    status: 401,
    meaning: 'The access token is past its lifetime.',
    whatToDo: 'Call `POST /auth/refresh` and retry with the new token.',
    retry: 'after-fixing',
  },
  TOKEN_REUSED: {
    status: 401,
    meaning:
      'A refresh token was presented twice, which means it may have been stolen, so the whole session family was revoked.',
    whatToDo: 'Sign in again. If this was not you, the sessions list shows what was ended.',
    retry: 'never',
  },
  INVALID_API_KEY: {
    status: 401,
    meaning:
      'The key is unknown, revoked, expired, belongs to another workspace, or its secret does not match. One answer for all of them, deliberately.',
    whatToDo: 'Check both halves of the credential. If it may have leaked, rotate it.',
    retry: 'never',
  },
  FORBIDDEN: {
    status: 403,
    meaning:
      'The caller is known but may not do this — an address off a key’s allowlist, or a route that is only for a signed-in person.',
    whatToDo: 'Read the message: it names which of the two it was.',
    retry: 'never',
  },
  PERMISSION_DENIED: {
    status: 403,
    meaning: 'The permission this route declares is not held.',
    whatToDo:
      '`error.details.permission` names it. For a key, it must be in the key’s scopes **and** held by the member who created it.',
    retry: 'never',
  },
  OUT_OF_DATA_SCOPE: {
    status: 403,
    meaning:
      'The permission is held, but not widely enough: the route needs it across the branch or the organization.',
    whatToDo: '`error.details` names what is granted and what is required.',
    retry: 'never',
  },
  ORG_SUSPENDED: {
    status: 403,
    meaning: 'The workspace is suspended or cancelled, so it accepts no writes.',
    whatToDo: 'The business has to resolve it with us; nothing a client sends will change it.',
    retry: 'never',
  },
  TRIAL_EXPIRED: {
    status: 403,
    meaning: 'The trial has ended, so the workspace is in read-only mode.',
    whatToDo: 'Reads keep working. Writes resume when a plan is chosen.',
    retry: 'never',
  },
  SUBSCRIPTION_INACTIVE: {
    status: 403,
    meaning: 'The subscription is past due or cancelled.',
    whatToDo: 'As for a trial: reads work, writes wait on billing.',
    retry: 'never',
  },
  FEATURE_NOT_IN_PLAN: {
    status: 403,
    meaning: 'The endpoint belongs to a feature the workspace’s plan does not include.',
    whatToDo: '`GET /auth/me` lists the entitlements this workspace actually has.',
    retry: 'never',
  },
  LIMIT_EXCEEDED: {
    status: 403,
    meaning:
      'A plan quota is full — seats, leads, messages. A business condition, which is why it is not a 429.',
    whatToDo: '`error.details` carries the limit and what is used. Retrying will not help.',
    retry: 'never',
  },
  NOT_FOUND: {
    status: 404,
    meaning:
      'No such resource — or it belongs to another workspace, or a malformed id was sent. Indistinguishable on purpose.',
    whatToDo: 'Check the id. The shape of an id is never an oracle for what exists.',
    retry: 'never',
  },
  CONFLICT: {
    status: 409,
    meaning: 'The write conflicts with what is already stored, usually a uniqueness rule.',
    whatToDo: 'Read the current state and decide; do not retry the same body.',
    retry: 'never',
  },
  DUPLICATE_LEAD: {
    status: 409,
    meaning: 'The workspace’s duplicate rules matched an existing lead.',
    whatToDo:
      'The response names the lead. On the capture endpoint this is not an error: the touchpoint is attached to the person who already exists.',
    retry: 'never',
  },
  STALE_VERSION: {
    status: 409,
    meaning: 'Somebody changed the record since the version that was sent.',
    whatToDo: 'Re-read it, re-apply the change, and send the new version.',
    retry: 'after-fixing',
  },
  IDEMPOTENT_REPLAY_MISMATCH: {
    status: 409,
    meaning: 'An `Idempotency-Key` was reused with a different body.',
    whatToDo:
      'Use a new key for a new request. The same key always answers the first request’s response.',
    retry: 'after-fixing',
  },
  BUSINESS_RULE_VIOLATION: {
    status: 422,
    meaning:
      'The request is well-formed and the product refuses it — a quotation already sent, a counter that cannot move backwards.',
    whatToDo: 'Show the message: it is written for a person, not for a log.',
    retry: 'never',
  },
  RATE_LIMITED: {
    status: 429,
    meaning: 'Too many requests in the window — a technical condition, unlike `LIMIT_EXCEEDED`.',
    whatToDo: 'Wait `error.details.retryAfterSeconds` and retry. Nothing was lost.',
    retry: 'with-backoff',
  },
  INTEGRATION_UNAVAILABLE: {
    status: 502,
    meaning: 'A provider we depend on could not be reached.',
    whatToDo: 'Retry with backoff. The workspace’s integration health screen shows the detail.',
    retry: 'with-backoff',
  },
  PROVIDER_ERROR: {
    status: 502,
    meaning: 'A provider answered with an error we cannot resolve for you.',
    whatToDo: 'Retry with backoff; if it persists, the message names the provider.',
    retry: 'with-backoff',
  },
  INTERNAL_ERROR: {
    status: 500,
    meaning: 'Our fault. The response carries a `requestId`.',
    whatToDo: 'Retry with backoff, and quote the `requestId` if it keeps happening.',
    retry: 'with-backoff',
  },
};

/** Every code, in the order the published errors page lists them: by status, then by name. */
export function errorCatalogueEntries(): readonly (ErrorDefinition & { code: ErrorCode })[] {
  return (Object.entries(ERROR_CATALOGUE) as [ErrorCode, ErrorDefinition][])
    .map(([code, definition]) => ({ code, ...definition }))
    .sort((a, b) => a.status - b.status || a.code.localeCompare(b.code));
}

/** The statuses any authenticated route can answer, so the document does not repeat itself. */
export const COMMON_ERROR_STATUSES = [400, 401, 403, 404, 422, 429, 500] as const;
