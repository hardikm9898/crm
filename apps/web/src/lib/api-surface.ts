/**
 * The developer platform's vocabulary, as the screens need it (`FR-API-1`, `FR-SA-4`).
 *
 * Hand-written rather than imported from `@leados/shared`, for the reason `lib/tasks.ts` gives: the
 * shared entry point reaches `node:async_hooks` and a client component that transitively imports it
 * fails `next build`. `api-surface.spec.ts` reconciles the two, and it can, because a spec runs in
 * Node and may import both.
 */

import { request } from './api';

export const INGESTION_SCOPES = ['ingest:write', 'ingest:read'] as const;

/**
 * The permissions a key may be granted. The same list as the API's, in the same order, which the
 * spec asserts — a screen offering a scope the API refuses is a tick box that produces a 400, and
 * one missing a scope the API accepts is a feature nobody can reach.
 */
export const API_GRANTABLE_PERMISSIONS = [
  'organization:read',
  'user:read',
  'role:read',
  'settings:read',
  'lead:read',
  'lead:create',
  'lead:update',
  'lead:assign',
  'customer:read',
  'customer:manage',
  'task:read',
  'task:manage',
  'sla:read',
  'deal:read',
  'deal:manage',
  'call:read',
  'call:log',
  'payment:read',
  'form:read',
  'report:read',
  'export:data',
] as const;

export const API_KEY_SCOPES = [...INGESTION_SCOPES, ...API_GRANTABLE_PERMISSIONS] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * What each scope lets a program do, said as the thing it can do rather than as its key.
 *
 * "Read leads" is what `lead:read` means to the person deciding whether an agency's integration
 * should have it; `lead:read` is what it means to the person writing the integration. Both are on
 * the screen, the sentence first.
 */
export const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'ingest:write': 'Post leads to the public endpoint',
  'ingest:read': 'Read back what it has sent',
  'organization:read': 'Read the workspace’s profile',
  'user:read': 'Read the list of members',
  'role:read': 'Read the roles',
  'settings:read': 'Read statuses, pipelines and other settings',
  'lead:read': 'Read leads',
  'lead:create': 'Create leads',
  'lead:update': 'Change leads',
  'lead:assign': 'Assign leads to people',
  'customer:read': 'Read customers',
  'customer:manage': 'Create and change customers',
  'task:read': 'Read follow-ups',
  'task:manage': 'Create and complete follow-ups',
  'sla:read': 'Read response promises and their clocks',
  'deal:read': 'Read deals',
  'deal:manage': 'Create and change deals',
  'call:read': 'Read the call log',
  'call:log': 'Log calls',
  'payment:read': 'Read payments',
  'form:read': 'Read capture forms and their submissions',
  'report:read': 'Read reports',
  'export:data': 'Export data, without personal details',
};

/** The groups the picker shows, so twenty-three tick boxes read as six decisions. */
export const SCOPE_GROUPS: readonly { label: string; hint: string; scopes: ApiKeyScope[] }[] = [
  {
    label: 'Posting leads in',
    hint: 'The public endpoint a website or an ad platform posts to. No session, signed with this key’s secret.',
    scopes: ['ingest:write', 'ingest:read'],
  },
  {
    label: 'Leads',
    hint: 'The REST API, called with this key instead of somebody signing in.',
    scopes: ['lead:read', 'lead:create', 'lead:update', 'lead:assign'],
  },
  {
    label: 'Customers, deals and money',
    hint: 'Reading is safe to grant; changing is not, so they are separate.',
    scopes: ['customer:read', 'customer:manage', 'deal:read', 'deal:manage', 'payment:read'],
  },
  {
    label: 'Follow-ups and calls',
    hint: 'What a dialler or a scheduling tool needs.',
    scopes: ['task:read', 'task:manage', 'sla:read', 'call:read', 'call:log'],
  },
  {
    label: 'Reading the workspace',
    hint: 'The lists an integration needs before it can send anything useful.',
    scopes: ['organization:read', 'user:read', 'role:read', 'settings:read', 'form:read'],
  },
  {
    label: 'Reporting',
    hint: 'Figures and exports. Personal details are deliberately not grantable to a key.',
    scopes: ['report:read', 'export:data'],
  },
];

/**
 * The permissions a key can never hold, and why — printed on the screen rather than left as an
 * absence somebody has to notice.
 */
export const WITHHELD_FROM_KEYS =
  'A key can never manage roles, members, billing, other keys, webhooks or privacy requests, and it cannot export personal details. Those stay with a person signing in, where they are auditable to a human being.';

// ── The request log ─────────────────────────────────────────────────────────

export type ApiSurface = 'rest' | 'public_ingest';
export type StatusClass = 'success' | 'client_error' | 'server_error' | 'other';

export interface ApiLogRow {
  id: string;
  apiKey: { id: string; name: string; keyPrefix: string } | null;
  surface: ApiSurface;
  method: string;
  path: string;
  statusCode: number;
  errorCode: string | null;
  durationMs: number;
  bytesIn: number;
  bytesOut: number;
  requestId: string;
  ip: string | null;
  createdAt: string;
}

export interface ApiLogSummary {
  requests: number;
  succeeded: number;
  refused: number;
  failed: number;
  averageDurationMs: number | null;
  slowestDurationMs: number | null;
}

export interface ApiKeyUsage {
  apiKeyId: string | null;
  requests: number;
  refused: number;
  lastRequestAt: string | null;
}

export const SURFACE_LABELS: Record<ApiSurface, string> = {
  rest: 'REST API',
  public_ingest: 'Public lead endpoint',
};

export function statusClass(status: number): StatusClass {
  if (status >= 200 && status < 400) return 'success';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'other';
}

/**
 * Three outcomes, not two.
 *
 * "Refused" is something the caller can fix — a wrong secret, a missing scope, a rate limit — and
 * "failed" is ours. Colouring them alike would bury the handful of rows on this screen that are
 * our fault among the hundreds that are not.
 */
export const STATUS_CLASS_LABELS: Record<StatusClass, string> = {
  success: 'Answered',
  client_error: 'Refused',
  server_error: 'Failed',
  other: 'Other',
};

export const STATUS_CLASS_CLASSES: Record<StatusClass, string> = {
  success: 'bg-emerald-100 text-emerald-900',
  client_error: 'bg-amber-100 text-amber-900',
  server_error: 'bg-rose-100 text-rose-900',
  other: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
};

/** A duration in words: `120 ms`, `1.4 s`. */
export function describeDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The sentence above the log.
 *
 * A clause per thing that is true, each with its own plural, and nothing that is zero — the rule
 * `/today`'s summary had to learn twice. "Nothing yet" is said in full rather than as "0 requests",
 * because a workspace that has just made a key needs to know whether to wait or to check their code.
 */
export function describeApiActivity(summary: ApiLogSummary, windowHours = 24): string {
  const window = windowHours === 24 ? 'in the last day' : `in the last ${windowHours} hours`;
  if (summary.requests === 0) {
    return `No requests ${window}. Once your integration sends one, it appears here with what we answered.`;
  }

  const clauses = [`${summary.requests} ${plural(summary.requests, 'request')} ${window}`];
  if (summary.refused > 0) {
    clauses.push(`${summary.refused} refused — see why below`);
  }
  if (summary.failed > 0) {
    clauses.push(`${summary.failed} ${plural(summary.failed, 'failure')} on our side`);
  }
  if (summary.refused === 0 && summary.failed === 0) {
    clauses.push('all answered');
  }
  if (summary.averageDurationMs !== null) {
    clauses.push(`${describeDuration(summary.averageDurationMs)} on average`);
  }
  return `${clauses.join(' · ')}.`;
}

/** What a key has been doing, for the row beside it. */
export function describeKeyUsage(usage: ApiKeyUsage | undefined): string {
  if (!usage || usage.requests === 0) return 'No requests in the last day.';
  const refused =
    usage.refused > 0
      ? `, ${usage.refused} of them refused`
      : '';
  return `${usage.requests} ${plural(usage.requests, 'request')} in the last day${refused}.`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

// ── Reading it ──────────────────────────────────────────────────────────────


/**
 * The log, with the summary that came back **with it**.
 *
 * One read, so the figures above the list and the list itself cannot disagree — the recurring bug
 * in this codebase is a number beside a filtered screen that is not itself filtered.
 */
export async function loadApiLog(
  token: string | null,
  query = '',
): Promise<{ items: ApiLogRow[]; total: number; summary: ApiLogSummary; since: string }> {
  const page = await request<ApiLogRow[]>(`/api-logs${query}`, { token });
  return {
    items: page.data,
    total: page.pagination?.total ?? page.data.length,
    summary: (page.meta?.['summary'] as ApiLogSummary | undefined) ?? {
      requests: 0,
      succeeded: 0,
      refused: 0,
      failed: 0,
      averageDurationMs: null,
      slowestDurationMs: null,
    },
    since: String(page.meta?.['since'] ?? ''),
  };
}

export async function loadKeyUsage(token: string | null): Promise<ApiKeyUsage[]> {
  return (await request<ApiKeyUsage[]>('/api-logs/usage', { token })).data;
}

/**
 * The request to copy, with both halves of the credential read from shell variables.
 *
 * A snippet with a secret pasted into it is a secret in a browser's history, in a screenshot and in
 * a support ticket — the same argument the capture snippet makes, and the reason neither prints
 * one.
 */
export function restSnippet(baseUrl: string): string {
  return [
    `export LEADOS_KEY_ID=pk_live_…           # the key id you copied when the key was made`,
    `export LEADOS_SECRET=sk_live_…           # and its secret, which is not shown again`,
    ``,
    // The versioned prefix, written here rather than assumed from the base URL: `apiBaseUrl()` is
    // an origin, and a snippet that omitted `/api/v1` would 404 for everybody who copied it.
    `curl ${baseUrl.replace(/\/+$/, '')}/api/v1/leads?limit=10 \\`,
    `  -H "Authorization: Bearer $LEADOS_KEY_ID.$LEADOS_SECRET"`,
  ].join('\n');
}
