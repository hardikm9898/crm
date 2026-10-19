import { request } from '@/lib/api';
import { relativeWhen } from '@/lib/forms';

/**
 * The integration framework, on the web side (Phase 4's "provider registry, credential vault,
 * health checks, generic mapping templates").
 *
 * The vocabulary is **declared here rather than imported from `@leados/shared`**, for the reason
 * `tasks.ts`, `forms.ts`, `ingestion.ts` and `webhooks.ts` all state: that package's entry point
 * reaches `node:async_hooks` through the tenant context, and a client component that transitively
 * imports it fails `next build` outright. `integrations.spec.ts` runs in Node, may import both, and
 * reconciles the two — which matters most for the **mappable fields**, because a target this screen
 * offers that the API refuses is a mapping somebody writes and cannot save, and one the API accepts
 * that this screen omits is a field nobody can map.
 */

export const INTEGRATION_STATUSES = ['connected', 'degraded', 'error', 'revoked'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const PROBE_OUTCOMES = ['ok', 'degraded', 'unauthorized', 'unreachable'] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

export const MAPPING_TRANSFORMS = ['none', 'trim', 'lowercase', 'digits', 'phone', 'boolean'] as const;
export type MappingTransform = (typeof MAPPING_TRANSFORMS)[number];

export const MAPPABLE_LEAD_FIELDS = [
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
  'message',
  'source',
  'pageUrl',
  'referrer',
  'valueMinor',
] as const;
export type MappableLeadField = (typeof MAPPABLE_LEAD_FIELDS)[number];

/**
 * What each target is, in the words of the business rather than the schema.
 *
 * Somebody building a mapping is reading their own provider's field names on one side; the other
 * side must not also be jargon. "Changed billingLine1" is the shape of mistake this avoids.
 */
export const FIELD_LABELS: Record<MappableLeadField, string> = {
  name: 'Full name',
  firstName: 'First name',
  lastName: 'Surname',
  company: 'Company',
  jobTitle: 'Job title',
  phone: 'Phone number',
  whatsapp: 'WhatsApp number',
  email: 'Email address',
  city: 'City',
  state: 'State',
  country: 'Country (two letters)',
  postalCode: 'Postcode',
  message: 'What they said',
  source: 'Where it came from',
  pageUrl: 'Page they enquired from',
  referrer: 'Page before that',
  valueMinor: 'Value (in paise/cents)',
};

/** What each transform does to a value, said as an example rather than as a name. */
export const TRANSFORM_LABELS: Record<MappingTransform, string> = {
  none: 'As sent',
  trim: 'Trim the spaces',
  lowercase: 'Lower case',
  digits: 'Digits only',
  phone: 'Tidy a phone number',
  boolean: 'Yes/no → true/false',
};

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  connected: 'Working',
  degraded: 'Last check failed',
  error: 'Failing',
  revoked: 'Needs reconnecting',
};

export const STATUS_CLASSES: Record<IntegrationStatus, string> = {
  connected: 'bg-[var(--color-success-soft)] text-[var(--color-success-strong)]',
  degraded: 'bg-[var(--color-warning-soft)] text-[var(--color-warning-strong)]',
  error: 'bg-[var(--color-danger-soft)] text-[var(--color-danger-strong)]',
  revoked: 'bg-[var(--color-danger-soft)] text-[var(--color-danger-strong)]',
};

export const OUTCOME_LABELS: Record<ProbeOutcome, string> = {
  ok: 'Answered',
  degraded: 'Answered and refused',
  unauthorized: 'Credential refused',
  unreachable: 'No answer',
};

// ── What the API answers ────────────────────────────────────────────────────

export interface ProviderSetting {
  key: string;
  label: string;
  hint?: string;
  required: boolean;
}

export interface FieldMapping {
  source: string;
  target: string;
  transform?: MappingTransform;
}

export interface ProviderOption {
  key: string;
  label: string;
  summary: string;
  capabilities: string[];
  authKind: 'api_key' | 'shared_secret';
  /** The secrets this provider's form asks for, by name. Empty when we generate the secret. */
  credentialFields: ProviderSetting[];
  settings: ProviderSetting[];
  mappable: boolean;
  defaultMapping: FieldMapping[];
  probeEveryMinutes: number | null;
  probeable: boolean;
  /** Whether this provider posts deliveries to us, and therefore has an inbound address. */
  inboundVerification: 'hmac_header' | 'payload_key' | 'none';
  connection: { id: string; name: string; status: IntegrationStatus; summary: string } | null;
}

export interface HealthCheckRow {
  outcome: ProbeOutcome;
  latencyMs: number | null;
  checkedAt: string;
  detail: Record<string, unknown>;
}

export interface ConnectionRecord {
  id: string;
  provider: string;
  inboundVerification?: 'hmac_header' | 'payload_key' | 'none';
  providerLabel: string;
  capabilities: string[];
  authKind: 'api_key' | 'shared_secret' | null;
  name: string;
  externalAccountId: string | null;
  settings: Record<string, unknown>;
  fieldMappings: FieldMapping[];
  status: IntegrationStatus;
  statusSummary: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  recentChecks: HealthCheckRow[];
}

export interface CreatedConnection extends ConnectionRecord {
  secret?: string;
  secretShownOnce?: boolean;
}

/** One thing a provider has told us, and what became of it. */
export interface ProviderEventRow {
  id: string;
  provider: string;
  providerLabel: string;
  connection: { id: string; provider: string; name: string } | null;
  externalEventId: string;
  eventType: string;
  status: 'received' | 'processed' | 'duplicate' | 'failed';
  leadId: string | null;
  error: string | null;
  attempts: number;
  receivedAt: string;
  processedAt: string | null;
  raw: Record<string, unknown>;
}

export const EVENT_STATUS_LABELS: Record<ProviderEventRow['status'], string> = {
  received: 'Queued',
  processed: 'Became a lead',
  // Your own duplicate rules, not a redelivery: this person was already a lead, so the enquiry was
  // added to the record they already had. A redelivery never appears here at all.
  duplicate: 'Added to an existing lead',
  failed: 'Did not become a lead',
};

export const EVENT_STATUS_CLASSES: Record<ProviderEventRow['status'], string> = {
  received: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  processed: 'bg-[var(--color-success-soft)] text-[var(--color-success-strong)]',
  duplicate: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  failed: 'bg-[var(--color-danger-soft)] text-[var(--color-danger-strong)]',
};

// ── Sentences ───────────────────────────────────────────────────────────────

/**
 * The summary above the screen.
 *
 * Every clause has its own plural, because a sentence assembled from clauses that counts to one as
 * "1 connections" reads as machine output — which is the one thing a hand-written sentence exists
 * to avoid. And nothing that is zero is pushed, because "0 need attention" is noise beside a
 * workspace where everything works.
 */
export function describeIntegrations(counts: {
  connected: number;
  needsAttention: number;
  available: number;
}): string {
  if (counts.connected === 0) {
    return `Nothing connected yet. ${counts.available} ${
      counts.available === 1 ? 'provider is' : 'providers are'
    } available — connect one and it starts working straight away.`;
  }
  const clauses = [
    `${counts.connected} ${counts.connected === 1 ? 'connection' : 'connections'}`,
  ];
  if (counts.needsAttention > 0) {
    clauses.push(
      counts.needsAttention === 1
        ? '1 needs your attention'
        : `${counts.needsAttention} need your attention`,
    );
  } else {
    clauses.push('all working');
  }
  return `${clauses.join(' · ')}.`;
}

/** The sentence under a connection's name. Mirrors the API's `describeStatus`, which the spec checks. */
export function describeStatus(status: IntegrationStatus, lastSuccessAt: string | null): string {
  switch (status) {
    case 'connected':
      return lastSuccessAt ? 'Working.' : 'Connected — nothing has used it yet.';
    case 'degraded':
      return 'The last check failed. We are still trying; nothing to do yet.';
    case 'error':
      return 'Repeated failures. Worth checking the provider’s own status page.';
    default:
      return 'The credential was refused — somebody has to reconnect it.';
  }
}

/** When it last did anything, and what went wrong if something did. */
export function describeActivity(connection: ConnectionRecord, now = new Date()): string {
  if (connection.lastSuccessAt === null && connection.lastErrorAt === null) {
    return 'Nothing has used it yet.';
  }
  if (connection.lastErrorAt === null) {
    return `Last worked ${relativeWhen(connection.lastSuccessAt as string, now)}.`;
  }
  const failed = `last failed ${relativeWhen(connection.lastErrorAt, now)}`;
  const reason = connection.lastError ? ` (${connection.lastError})` : '';
  if (connection.lastSuccessAt === null) return `Never worked — ${failed}${reason}.`;
  return `Last worked ${relativeWhen(connection.lastSuccessAt, now)}, ${failed}${reason}.`;
}

/** One probe, as a line in the history. */
export function describeCheck(check: HealthCheckRow, now = new Date()): string {
  const timing = check.latencyMs === null ? 'no answer' : `${check.latencyMs} ms`;
  const message = check.detail['message'] ?? check.detail['error'];
  const detail = typeof message === 'string' && message !== '' ? ` — ${message}` : '';
  return `${OUTCOME_LABELS[check.outcome]} · ${timing} · ${relativeWhen(check.checkedAt, now)}${detail}`;
}

/** Whether somebody has to do something, as opposed to waiting. */
export function needsReconnect(status: IntegrationStatus): boolean {
  return status === 'revoked';
}

/**
 * Whether a target is one a mapping may write.
 *
 * The same rule the API enforces, so the editor can refuse before a round trip — and the same
 * `custom.<key>` grammar, because a mapping that writes a custom field is the commonest reason
 * somebody opens this editor at all.
 */
export function isMappableTarget(target: string): boolean {
  if ((MAPPABLE_LEAD_FIELDS as readonly string[]).includes(target)) return true;
  if (!target.startsWith('custom.')) return false;
  return /^[a-z][a-z0-9_]{0,59}$/.test(target.slice('custom.'.length));
}

/** The inbound URL a sender is given, built in one place so the screen and the snippet agree. */
export function inboundUrl(apiBase: string, provider: string, connectionId: string): string {
  return `${apiBase.replace(/\/$/, '')}/api/v1/wh/${provider}/${connectionId}`;
}

/**
 * What to do with the address, in the provider's own words.
 *
 * Three providers post to us and each wants it somewhere different, which is the sentence somebody
 * is looking for when they copy it: the generic webhook signs with the secret, Google Ads is given
 * the key to echo, and Meta subscribes a Page to the callback URL.
 */
export function inboundInstruction(provider: string): string {
  switch (provider) {
    case 'meta_lead_ads':
      return 'In Meta for Developers, add this as the app’s Webhooks callback URL for the Page, with the verify token you set above, and subscribe it to leadgen.';
    case 'google_ads_leads':
      return 'In Google Ads, open the lead form extension → Webhook integration, and paste this URL with the key below.';
    default:
      return 'Have the sending system POST one lead per request to this address, signed with the secret.';
  }
}

/**
 * The signing a sender has to write, in their own language.
 *
 * On the screen rather than in a document somebody has to find, for the reason the outbound
 * snippet gives in reverse: the commonest reason a sender's requests are all refused is not knowing
 * exactly which bytes to hash.
 */
export function signingSnippet(url: string): string {
  return [
    `// Sign every request. The secret is the whsec_… shown when you connected.`,
    `import { createHmac } from 'node:crypto';`,
    ``,
    `const SECRET = process.env.LEADOS_CONNECTION_SECRET;`,
    `const body = JSON.stringify({ /* your own field names */ });`,
    `const t = Math.floor(Date.now() / 1000);                // seconds, not milliseconds`,
    `const v1 = createHmac('sha256', SECRET).update(\`\${t}.\${body}\`).digest('hex');`,
    ``,
    `await fetch('${url}', {`,
    `  method: 'POST',`,
    `  headers: {`,
    `    'content-type': 'application/json',`,
    `    'x-signature': \`t=\${t},v1=\${v1}\`,              // five minutes either way`,
    `    'idempotency-key': yourOwnEnquiryId,                // so a retry is not a second lead`,
    `  },`,
    `  body,                                                 // the exact bytes you signed`,
    `});`,
  ].join('\n');
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/**
 * Throwing, all of them: on a screen whose job is to list what is connected, an empty list and a
 * failed request look identical and must not — the product catalogue's permanent silent lie.
 */
export async function loadProviders(token: string | null): Promise<ProviderOption[]> {
  return (await request<ProviderOption[]>('/integrations/providers', { token })).data;
}

export async function loadConnections(
  token: string | null,
  query = '',
): Promise<ConnectionRecord[]> {
  return (await request<ConnectionRecord[]>(`/integrations${query}`, { token })).data;
}

/**
 * What each provider has told us (`provider_events`).
 *
 * Throwing, like the rest: on a screen whose job is to answer "why did that lead not appear", a
 * swallowed failure would say "nothing has arrived" to a workspace whose provider is delivering.
 */
export async function loadProviderEvents(
  token: string | null,
  query = '?limit=20',
): Promise<{ items: ProviderEventRow[]; unresolved: number }> {
  const page = await request<ProviderEventRow[]>(`/integrations/events${query}`, { token });
  return {
    items: page.data,
    // From the API's own `meta`, over the whole set rather than this page: a figure beside a list
    // that totals the page is the recurring bug in this codebase.
    unresolved: Number((page.meta as { unresolved?: unknown } | undefined)?.unresolved ?? 0),
  };
}

/** One ledger row, as a line somebody can act on. */
export function describeEvent(event: ProviderEventRow, now = new Date()): string {
  const when = relativeWhen(event.receivedAt, now);
  if (event.status === 'failed') {
    const attempts = `${event.attempts} ${event.attempts === 1 ? 'attempt' : 'attempts'}`;
    return `${when} · ${attempts} · ${event.error ?? 'no reason recorded'}`;
  }
  if (event.status === 'duplicate') {
    return `${when} · this person was already in your leads`;
  }
  return `${when} · ${event.eventType}`;
}

export async function loadHealthChecks(
  token: string | null,
  query = '?limit=20',
): Promise<(HealthCheckRow & { connection: { id: string; provider: string; name: string } })[]> {
  return (
    await request<(HealthCheckRow & { connection: { id: string; provider: string; name: string } })[]>(
      `/integrations/health${query}`,
      { token },
    )
  ).data;
}
