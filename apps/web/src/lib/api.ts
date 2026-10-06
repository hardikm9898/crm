/**
 * The API client.
 *
 * Deliberately thin and hand-written for now: the generated OpenAPI client arrives with Phase 4,
 * and until the spec is published a hand-rolled client that speaks the documented envelope is more
 * honest than a generated one that does not exist.
 *
 * Every call goes through `request`, which unwraps the envelope and turns `error.code` into a typed
 * failure — so screens branch on codes, never on message text (docs/api-architecture.md §2).
 */

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when signing in again is the remedy, which the shell uses to redirect. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

export interface Envelope<T> {
  success: boolean;
  data: T;
  message?: string;
  /** `requestId` and `pagination`, plus whatever the handler merged in. */
  meta?: { requestId?: string; pagination?: Pagination } & Record<string, unknown>;
  error?: ApiErrorShape;
}

export interface Pagination {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export interface Page<T> {
  items: T[];
  pagination?: Pagination;
  message?: string;
  /**
   * Whatever the handler returned alongside its rows, which the envelope merges into `meta`.
   *
   * The envelope drops a paginated payload's sibling keys unless the handler puts them here, so a
   * screen that needs a set-wide total (a deal list's value, a search's view name) reads it from
   * this rather than from the rows it happens to have been given.
   */
  meta?: Record<string, unknown>;
}

export function apiBaseUrl(): string {
  return process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  /** Forwarded so a browser request carries the refresh cookie on auth routes. */
  credentials?: RequestCredentials;
  signal?: AbortSignal;
  /**
   * A body that is **not** JSON: a CSV upload, where the file's contents are the request.
   *
   * Separate from `body` rather than a union, so nothing can accidentally send a string through
   * `JSON.stringify` and upload `"name,phone\n..."` — quoted, escaped and unparseable.
   */
  rawBody?: { readonly content: string; readonly contentType: string };
}

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<Page<T> & { data: T }> {
  const response = await fetch(`${apiBaseUrl()}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.rawBody ? { 'content-type': options.rawBody.contentType } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.rawBody ? { body: options.rawBody.content } : {}),
    credentials: options.credentials ?? 'include',
    ...(options.signal ? { signal: options.signal } : {}),
    cache: 'no-store',
  });

  const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;

  if (!response.ok || !envelope?.success) {
    const error = envelope?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? 'Something went wrong',
      error?.details,
      error?.requestId,
    );
  }

  return {
    data: envelope.data,
    items: Array.isArray(envelope.data) ? (envelope.data as T[]) : [],
    ...(envelope.meta?.pagination ? { pagination: envelope.meta.pagination } : {}),
    ...(envelope.meta ? { meta: envelope.meta as Record<string, unknown> } : {}),
    ...(envelope.message ? { message: envelope.message } : {}),
  };
}

/**
 * Codes where **this app's** wording wins over the API's message.
 *
 * Session and access failures, where the API's text is either terse, aimed at an integrator, or
 * something that should not be repeated verbatim to a browser — "no tenant context", a permission
 * key, a plan feature flag. For these the app says the one sentence that is useful: sign in again.
 */
export const ERROR_OVERRIDES: Record<string, string> = {
  UNAUTHENTICATED: 'Please sign in again.',
  TOKEN_EXPIRED: 'Your session expired. Please sign in again.',
  TOKEN_REUSED: 'Your session was ended for security reasons. Please sign in again.',
  PERMISSION_DENIED: 'You do not have access to do that.',
  OUT_OF_DATA_SCOPE: 'Your access covers a narrower set of records than this page needs.',
  ORG_SUSPENDED: 'This workspace has been suspended. Contact support.',
  TRIAL_EXPIRED: 'Your free trial has ended. Your data is safe — choose a plan to continue.',
  SUBSCRIPTION_INACTIVE: 'Your subscription has lapsed. Your data is safe — renew to continue.',
  FEATURE_NOT_IN_PLAN: 'That feature is not included in your current plan.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
};

/**
 * Codes where the API's own sentence wins, and this is only what to say when it has none.
 *
 * A business-rule refusal is the API explaining itself to a person: "This deal’s value comes from
 * its line items", "Deactivate it instead — it will stop appearing when somebody adds a line", "The
 * counter is already at 2. It can be moved forward, but not back". Those sentences were written for
 * exactly this moment, and replacing them with "That is not allowed." turns a refusal that tells
 * somebody what to do next into a dead end. That is what used to happen here, to every refusal in
 * the product.
 */
export const ERROR_FALLBACKS: Record<string, string> = {
  LIMIT_EXCEEDED: 'You have reached your plan limit.',
  VALIDATION_FAILED: 'Some details need correcting.',
  CONFLICT: 'That conflicts with something that already exists.',
  BUSINESS_RULE_VIOLATION: 'That is not allowed.',
  NOT_FOUND: 'Not found.',
};

/** Kept for callers that want the whole map; the two halves above are the contract. */
export const ERROR_COPY: Record<string, string> = { ...ERROR_FALLBACKS, ...ERROR_OVERRIDES };

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  const override = ERROR_OVERRIDES[error.code];
  if (override) return override;
  const message = error.message?.trim();
  if (message) return message;
  return ERROR_FALLBACKS[error.code] ?? 'Something went wrong. Please try again.';
}
