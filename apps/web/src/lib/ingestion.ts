import { request } from '@/lib/api';
import { relativeWhen } from '@/lib/forms';

/**
 * The public lead API, on the web side (`FR-CAP-5`, `FR-CAP-6`, `FR-CAP-7`, `FR-API-2`).
 *
 * Two screens read this: the key list (a credential, created once and never shown again) and the
 * integration log (what arrived, what it became, and the fields this workspace has no home for).
 *
 * The vocabulary is **declared here rather than imported from `@leados/shared`**, for the reason
 * `tasks.ts`, `calls.ts` and `forms.ts` state: that package's entry point reaches
 * `node:async_hooks` through the tenant context, and a client component that transitively imports
 * it fails `next build` outright. `ingestion.spec.ts` runs in Node, may import both, and reconciles
 * the two — which matters most for the **scope list**, because a scope this screen offers that the
 * API refuses is a key that cannot be created, and one the API knows that this screen omits is a
 * key nobody can grant.
 *
 * `relativeWhen` is imported rather than written again: a second "how long ago" with its own
 * rounding is how two screens end up disagreeing about the same timestamp.
 */

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

export const INBOUND_STATUSES = ['received', 'processed', 'duplicate', 'failed'] as const;
export type InboundStatus = (typeof INBOUND_STATUSES)[number];

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

export const API_KEY_SCOPES = ['ingest:write', 'ingest:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Where a payload came from, as somebody who did not build the integration would say it. */
export const CHANNEL_LABELS: Record<IngestChannel, string> = {
  public_api: 'The lead API',
  webhook: 'A webhook',
  meta_ads: 'Facebook or Instagram',
  google_ads: 'Google Ads',
  form: 'A capture form',
  whatsapp: 'WhatsApp',
  import: 'A spreadsheet import',
};

/** What became of it. `received` is the never-lose state: stored, not yet attempted. */
export const PAYLOAD_STATUS_LABELS: Record<InboundStatus, string> = {
  received: 'Stored, not processed yet',
  processed: 'Became a lead',
  duplicate: 'Added to an existing lead',
  failed: 'Did not become a lead',
};

/**
 * `failed` is rose and `received` is muted, for the reason the submissions list gives: the rows
 * somebody has to act on must not be coloured like the hundreds they do not.
 */
export const PAYLOAD_STATUS_CLASSES: Record<InboundStatus, string> = {
  received: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  processed: 'bg-emerald-100 text-emerald-900',
  duplicate: 'bg-sky-100 text-sky-900',
  failed: 'bg-rose-100 text-rose-900',
};

/**
 * The step of the pipeline a failure happened in, said as a consequence rather than as a stage
 * name: "authenticate" is a word from our architecture, and the person reading this screen wants to
 * know whose fault it is and what to change.
 */
export const STAGE_LABELS: Record<IngestionStage, string> = {
  authenticate: 'The credentials were refused',
  validate: 'The payload was not acceptable',
  normalize: 'A value could not be made sense of',
  duplicate_check: 'The duplicate rules refused it',
  persist: 'Saving it failed',
  assign: 'Choosing an owner failed',
  notify: 'Telling somebody failed',
};

export const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'ingest:write': 'Post leads into this workspace',
  'ingest:read': 'Read back what it has sent',
};

// ── What the API answers ────────────────────────────────────────────────────

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  ipAllowlist: string[];
  rateLimitPerMin: number | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  isLive: boolean;
  createdAt: string;
}

/** `create` and `rotate` only, and exactly once each (`FR-CAP-7`). */
export interface CreatedApiKey extends ApiKeyRecord {
  keyId: string;
  secret: string;
  secretShownOnce: true;
}

export interface PayloadErrorRow {
  stage: string;
  code: string | null;
  message: string;
  isReplayable: boolean;
  createdAt: string;
}

export interface PayloadRow {
  id: string;
  channel: string;
  status: InboundStatus;
  apiKey: { id: string; name: string; keyPrefix: string } | null;
  leadId: string | null;
  error: string | null;
  attempts: number;
  replayedAt: string | null;
  idempotencyKey: string | null;
  receivedAt: string;
  body: Record<string, unknown> | null;
  unmappedFields: string[];
  errors: PayloadErrorRow[];
}

export interface IngestionErrorRow {
  id: string;
  payloadId: string | null;
  stage: string;
  code: string | null;
  message: string;
  details: Record<string, unknown> | null;
  isReplayable: boolean;
  replayedAt: string | null;
  createdAt: string;
}

export interface UnmappedField {
  field: string;
  count: number;
  samples: string[];
}

export interface DryRunResult {
  wouldCreate: boolean;
  normalized: Record<string, unknown>;
  unmappedFields: string[];
  notes: string[];
}

// ── What a screen says about a key ──────────────────────────────────────────

export interface KeyStanding {
  readonly label: string;
  readonly tone: 'success' | 'neutral' | 'warning' | 'danger';
}

/**
 * Three states, not two.
 *
 * Expired and revoked both mean "this key no longer works" and are not the same thing to the person
 * looking: a revoked key was switched off deliberately and an expired one ran out while nobody was
 * watching, which is the one of the two that is probably a broken integration right now.
 */
export function keyStanding(key: ApiKeyRecord, now = new Date()): KeyStanding {
  if (key.revokedAt !== null) return { label: 'Revoked', tone: 'danger' };
  if (key.expiresAt !== null && new Date(key.expiresAt) <= now) {
    return { label: 'Expired', tone: 'warning' };
  }
  return { label: 'Live', tone: 'success' };
}

/**
 * "Last used 20 minutes ago, from 203.0.113.7", or the honest absence.
 *
 * A key that has never been used is the commonest support question on this screen — somebody
 * created it, pasted it somewhere, and nothing arrived — so it says so rather than printing a dash.
 */
export function describeKeyUse(key: ApiKeyRecord, now = new Date()): string {
  if (!key.lastUsedAt) return 'Never used — nothing has signed a request with it yet.';
  const when = relativeWhen(key.lastUsedAt, now);
  return key.lastUsedIp ? `Last used ${when}, from ${key.lastUsedIp}.` : `Last used ${when}.`;
}

// ── Turning an unmapped field into a custom field ───────────────────────────

/**
 * Keys a custom field may not take. The same list the API enforces, trimmed to what an integration
 * plausibly sends — a mismatch here costs a refusal naming a field nobody typed, which is why
 * `ingestion.spec.ts` asserts every entry is one the shared list also refuses.
 */
const RESERVED_SUGGESTIONS = new Set([
  'id',
  'first_name',
  'last_name',
  'full_name',
  'company',
  'email',
  'phone',
  'city',
  'state',
  'country',
  'postal_code',
  'status',
  'stage',
  'pipeline',
  'source',
  'priority',
  'score',
  'tags',
  'owner',
  'assigned_to',
  'value',
  'currency',
  'notes',
]);

/**
 * The key a one-click "make this a field" would use.
 *
 * `propertyType` arrives from an integrator who writes camelCase, and the custom field key rule is
 * deliberately narrow (lowercase, starting with a letter, no dots — it ends up in JSONB paths and
 * generated index expressions). So the suggestion is derived, and `null` when nothing valid can be
 * derived: offering a button that is certain to be refused is worse than not offering it.
 */
export function suggestedFieldKey(field: string): string | null {
  const key = field
    .trim()
    // `propertyType` → `property_type`, before lowercasing, or the word boundary is lost.
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .slice(0, 49);
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(key)) return null;
  return RESERVED_SUGGESTIONS.has(key) ? null : key;
}

/**
 * The label somebody would read.
 *
 * Splits camelCase as well as snake_case, which is the `humanise` lesson from the timeline: a field
 * list showing "propertyType" is showing a business owner the name a developer wrote.
 */
export function suggestedFieldLabel(field: string): string {
  const words = field
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return field;
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase(),
    )
    .join(' ');
}

/**
 * Which kind of field the samples suggest.
 *
 * A guess, and said as one on the screen — but a guess with a real cost if it is absent: "propertyType"
 * alone does not tell anybody whether it wants a text box or a dropdown, which is why the samples
 * are carried through the API at all. A handful of repeated values is a `select`; two digits of
 * nothing but digits is a number; and the default is `text`, which accepts anything already sent.
 */
export function suggestedFieldType(samples: readonly string[]): string {
  const values = samples.map((sample) => sample.trim()).filter((sample) => sample !== '');
  if (values.length === 0) return 'text';
  const every = (test: (value: string) => boolean): boolean => values.every(test);

  if (every((value) => /^(true|false|yes|no)$/i.test(value))) return 'boolean';
  if (every((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))) return 'email';
  if (every((value) => /^https?:\/\//i.test(value))) return 'url';
  if (every((value) => /^\+?[\d\s().-]{7,20}$/.test(value) && /\d{7}/.test(value.replace(/\D/g, ''))))
    return 'phone';
  if (every((value) => /^-?\d+$/.test(value))) return 'number';
  if (every((value) => /^-?\d+\.\d+$/.test(value))) return 'decimal';
  if (every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) return 'date';
  // A short vocabulary repeated across payloads is a choice list, not free text — but only once
  // there is enough evidence for that to be more than two coincidences.
  if (values.length >= 2 && new Set(values).size < values.length) return 'select';
  return 'text';
}

/**
 * The kinds of field this screen offers for an unmapped answer, with the words a business owner
 * would use. A subset of the API's seventeen types on purpose: `rating`, `file` and the grouped
 * choice types are things somebody designs on the field builder, not things a payload's extra key
 * implies — and a dropdown of seventeen is a decision nobody makes in one click.
 *
 * `suggestedFieldType` may only ever return one of these: a suggestion absent from the list would
 * preselect nothing and silently create a text field instead. `ingestion.spec.ts` asserts both
 * halves of that — every choice is a type the API accepts, and every suggestion is a choice.
 */
export const FIELD_TYPE_CHOICES: readonly { type: string; label: string }[] = [
  { type: 'text', label: 'Short text' },
  { type: 'textarea', label: 'Long text' },
  { type: 'number', label: 'A whole number' },
  { type: 'decimal', label: 'A number with decimals' },
  { type: 'select', label: 'One of a few choices' },
  { type: 'boolean', label: 'Yes or no' },
  { type: 'date', label: 'A date' },
  { type: 'email', label: 'An email address' },
  { type: 'phone', label: 'A phone number' },
  { type: 'url', label: 'A link' },
];

/**
 * The request an integrator has to make, with this workspace in it.
 *
 * A shell snippet rather than a language's SDK, and one that reads **both halves of the credential
 * from variables the person exports themselves**: a snippet with a secret pasted into it is a
 * secret in a browser's history, in a screenshot and in a support ticket. The key id is not a
 * secret, but it is also not knowable from this screen — the list shows a prefix, because a screen
 * printing full credentials invites a photograph of itself.
 */
export function curlSnippet({
  baseUrl,
  organizationPublicKey,
}: {
  baseUrl: string;
  organizationPublicKey: string;
}): string {
  return [
    `export LEADOS_KEY_ID=pk_live_…           # the key id you copied when the key was made`,
    `export LEADOS_SECRET=sk_live_…           # and its secret, which is not shown again`,
    `BODY='{"name":"Rohit Kulkarni","phone":"98450 12345","source":"Website"}'`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$LEADOS_SECRET" -r | cut -d' ' -f1)`,
    ``,
    `curl -X POST ${baseUrl.replace(/\/+$/, '')}/api/v1/public/leads/${organizationPublicKey} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Api-Key: $LEADOS_KEY_ID" \\`,
    `  -H "X-Signature: t=$TS,v1=$SIG" \\`,
    `  -H "Idempotency-Key: website-$(date +%s)" \\`,
    `  -d "$BODY"`,
  ].join('\n');
}

/**
 * One line of prose about the log, so the screen opens with a sentence rather than a table.
 *
 * Every clause carries its own plural. Today's summary read "1 missed promises" in front of a
 * browser check because three clauses of four did and the fourth did not, and a screen that cannot
 * count to one reads as machine output.
 */
export function describeIngestion(counts: {
  total: number;
  failed: number;
  unmappedFields: number;
}): string {
  if (counts.total === 0) return 'Nothing has been posted to the lead API yet.';

  const clauses = [`${counts.total} ${counts.total === 1 ? 'payload' : 'payloads'} stored`];
  clauses.push(
    counts.failed === 0
      ? 'every one of them accounted for'
      : counts.failed === 1
        ? '1 that did not become a lead'
        : `${counts.failed} that did not become leads`,
  );
  if (counts.unmappedFields > 0) {
    clauses.push(
      counts.unmappedFields === 1
        ? '1 field with nowhere to go'
        : `${counts.unmappedFields} fields with nowhere to go`,
    );
  }
  return `${clauses.join(' · ')}.`;
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/**
 * Throwing, every one of them.
 *
 * These screens exist to list credentials and arrivals, where "none" is itself information: a
 * swallowed 400 would tell a workspace its integration has sent nothing, which is the product
 * catalogue's permanent silent lie in a place where somebody would act on it.
 */
export async function loadApiKeys(token: string | null, query = ''): Promise<ApiKeyRecord[]> {
  return (await request<ApiKeyRecord[]>(`/api-keys${query}`, { token })).data;
}

export async function loadPayloads(
  token: string | null,
  query = '',
): Promise<{ items: PayloadRow[]; total: number }> {
  const page = await request<PayloadRow[]>(`/ingestion/payloads${query}`, { token });
  return { items: page.data, total: page.pagination?.total ?? page.data.length };
}

export async function loadIngestionErrors(
  token: string | null,
  query = '',
): Promise<IngestionErrorRow[]> {
  return (await request<IngestionErrorRow[]>(`/ingestion/errors${query}`, { token })).data;
}

export async function loadUnmappedFields(
  token: string | null,
): Promise<{ items: UnmappedField[]; payloadsScanned: number }> {
  const page = await request<UnmappedField[]>('/ingestion/unmapped', { token });
  return {
    items: page.data,
    payloadsScanned: Number(page.meta?.['payloadsScanned'] ?? 0),
  };
}
