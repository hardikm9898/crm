import { request } from '@/lib/api';
import { relativeWhen } from '@/lib/forms';

/**
 * Outbound webhooks, on the web side (`FR-API-4`).
 *
 * The vocabulary is **declared here rather than imported from `@leados/shared`**, for the reason
 * `tasks.ts`, `forms.ts` and `ingestion.ts` state: that package's entry point reaches
 * `node:async_hooks` through the tenant context, and a client component that transitively imports
 * it fails `next build` outright. `webhooks.spec.ts` runs in Node, may import both, and reconciles
 * the two — which matters most for the **event list**, because a type this screen offers that
 * nothing fans out is an endpoint that looks subscribed and receives nothing.
 */

export const WEBHOOK_EVENT_TYPES = [
  'lead.created',
  'lead.updated',
  'lead.assigned',
  'lead.status_changed',
  'lead.stage_changed',
  'lead.converted',
  'lead.merged',
  'lead.deleted',
  'lead.score_changed',
  'task.created',
  'task.completed',
  'task.rescheduled',
  'task.overdue',
  'call.logged',
  'customer.created',
  'customer.updated',
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'quotation.sent',
  'quotation.accepted',
  'quotation.rejected',
  'payment.received',
  'payment.refunded',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'exhausted'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** The reserved type an endpoint receives when somebody presses "send a test". */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

/**
 * What each event is, in the words of the business rather than the schema.
 *
 * A developer wiring this up reads `lead.status_changed`; the person deciding **which** events to
 * send reads "A lead's status changed". Both are on the screen, because the two readers are often
 * sitting next to each other.
 */
export const EVENT_LABELS: Record<WebhookEventType, string> = {
  'lead.created': 'A lead arrived',
  'lead.updated': 'A lead’s details changed',
  'lead.assigned': 'A lead was given an owner',
  'lead.status_changed': 'A lead’s status changed',
  'lead.stage_changed': 'A lead moved stage',
  'lead.converted': 'A lead became a customer',
  'lead.merged': 'Two leads were merged',
  'lead.deleted': 'A lead was deleted',
  'lead.score_changed': 'A lead’s score changed',
  'task.created': 'A follow-up was planned',
  'task.completed': 'A follow-up was done',
  'task.rescheduled': 'A follow-up moved',
  'task.overdue': 'A follow-up went overdue',
  'call.logged': 'A call was logged',
  'customer.created': 'A customer was added',
  'customer.updated': 'A customer’s details changed',
  'deal.created': 'A deal was opened',
  'deal.stage_changed': 'A deal moved stage',
  'deal.won': 'A deal was won',
  'deal.lost': 'A deal was lost',
  'quotation.sent': 'A quotation was sent',
  'quotation.accepted': 'A quotation was accepted',
  'quotation.rejected': 'A quotation was rejected',
  'payment.received': 'A payment arrived',
  'payment.refunded': 'A payment was refunded',
};

/** The groups the picker is laid out in, so twenty-five tick boxes are readable. */
export const EVENT_GROUPS: readonly { heading: string; prefix: string }[] = [
  { heading: 'Leads', prefix: 'lead.' },
  { heading: 'Follow-ups and calls', prefix: 'task.' },
  { heading: 'Calls', prefix: 'call.' },
  { heading: 'Customers', prefix: 'customer.' },
  { heading: 'Deals', prefix: 'deal.' },
  { heading: 'Quotations', prefix: 'quotation.' },
  { heading: 'Payments', prefix: 'payment.' },
];

export const DELIVERY_STATUS_LABELS: Record<WebhookDeliveryStatus, string> = {
  pending: 'Not sent yet',
  succeeded: 'Delivered',
  failed: 'Failed — will try again',
  exhausted: 'Gave up',
};

/**
 * `exhausted` is rose and `failed` is amber, deliberately: a failure is on its way to being
 * retried, and an exhausted delivery is one somebody has to decide about.
 */
export const DELIVERY_STATUS_CLASSES: Record<WebhookDeliveryStatus, string> = {
  pending: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  succeeded: 'bg-emerald-100 text-emerald-900',
  failed: 'bg-amber-100 text-amber-900',
  exhausted: 'bg-rose-100 text-rose-900',
};

// ── What the API answers ────────────────────────────────────────────────────

export interface WebhookEndpointRecord {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  isActive: boolean;
  failureCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastStatusCode: number | null;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
}

/** `create` and `rotate-secret` only, and exactly once each. */
export interface CreatedWebhookEndpoint extends WebhookEndpointRecord {
  secret: string;
  secretShownOnce: true;
}

export interface WebhookAttemptRow {
  attemptNo: number;
  statusCode: number | null;
  durationMs: number;
  responseBody: string | null;
  error: string | null;
  attemptedAt: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint: { id: string; url: string; description: string | null } | null;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastResponseBody: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  payload: Record<string, unknown> | null;
  attempts: WebhookAttemptRow[];
}

// ── What a screen says about an endpoint ────────────────────────────────────

export interface EndpointStanding {
  readonly label: string;
  readonly tone: 'success' | 'neutral' | 'warning' | 'danger';
}

/**
 * Three states, because "off" has two meanings.
 *
 * An endpoint somebody switched off is a decision; one **we** switched off after fifteen failures
 * is a broken integration, and conflating them would hide the only one that needs attention.
 */
export function endpointStanding(endpoint: WebhookEndpointRecord): EndpointStanding {
  if (endpoint.isActive) {
    return endpoint.failureCount > 0
      ? { label: `Live, ${endpoint.failureCount} failing`, tone: 'warning' }
      : { label: 'Live', tone: 'success' };
  }
  return endpoint.disabledReason !== null && !endpoint.disabledReason.startsWith('Switched off by')
    ? { label: 'Stopped by us', tone: 'danger' }
    : { label: 'Switched off', tone: 'neutral' };
}

/**
 * "Delivered 4 minutes ago", or the reason it is not.
 *
 * An endpoint that has never received anything is the commonest question this screen answers —
 * somebody created it, subscribed to an event nothing has done yet, and is waiting.
 */
export function describeEndpointActivity(
  endpoint: WebhookEndpointRecord,
  now = new Date(),
): string {
  if (endpoint.lastSuccessAt === null && endpoint.lastFailureAt === null) {
    return 'Nothing has been sent to it yet — it is waiting for one of its events to happen.';
  }
  if (endpoint.lastFailureAt === null) {
    return `Last delivered ${relativeWhen(endpoint.lastSuccessAt as string, now)}.`;
  }
  const failed = `last failed ${relativeWhen(endpoint.lastFailureAt, now)}`;
  const code = endpoint.lastStatusCode === null ? 'no answer' : `HTTP ${endpoint.lastStatusCode}`;
  if (endpoint.lastSuccessAt === null) return `Never delivered — ${failed} (${code}).`;
  return `Last delivered ${relativeWhen(endpoint.lastSuccessAt, now)}, ${failed} (${code}).`;
}

/** What a delivery row says about itself under the status chip. */
export function describeDelivery(delivery: WebhookDeliveryRow, now = new Date()): string {
  const attempts = `${delivery.attemptCount} ${delivery.attemptCount === 1 ? 'attempt' : 'attempts'}`;
  if (delivery.status === 'succeeded') {
    return `${attempts} · HTTP ${delivery.lastStatusCode ?? '—'}`;
  }
  if (delivery.status === 'pending') return 'Queued, not attempted yet';
  const reason = delivery.lastError ?? `HTTP ${delivery.lastStatusCode ?? '—'}`;
  if (delivery.status === 'failed' && delivery.nextAttemptAt !== null) {
    return `${attempts} · ${reason} · trying again ${relativeInFuture(delivery.nextAttemptAt, now)}`;
  }
  return `${attempts} · ${reason}`;
}

/** "in 4 minutes", the mirror of `relativeWhen`. A retry that is due reads as "any moment now". */
export function relativeInFuture(iso: string, now = new Date()): string {
  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'any moment now';
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** One line of prose about the log, with a plural in every clause. */
export function describeWebhooks(counts: {
  endpoints: number;
  live: number;
  failing: number;
}): string {
  if (counts.endpoints === 0) {
    return 'No endpoints yet. Add one and we will post every event you choose to your own server.';
  }
  const clauses = [
    `${counts.endpoints} ${counts.endpoints === 1 ? 'endpoint' : 'endpoints'}`,
    `${counts.live} live`,
  ];
  if (counts.failing > 0) {
    clauses.push(
      counts.failing === 1 ? '1 we have stopped sending to' : `${counts.failing} we have stopped sending to`,
    );
  }
  return `${clauses.join(' · ')}.`;
}

/**
 * The verification a receiver has to write, in their own language.
 *
 * On the screen rather than in a document somebody has to find, because the one thing that makes a
 * webhook endpoint unsafe is accepting it without checking the signature — and the commonest reason
 * somebody does not check is not knowing exactly what to hash. Node, because it is the language the
 * majority of the receivers this product sees are written in.
 */
export function verificationSnippet(): string {
  return [
    `// Verify every delivery before you trust it.`,
    `import { createHmac, timingSafeEqual } from 'node:crypto';`,
    ``,
    `const SECRET = process.env.LEADOS_WEBHOOK_SECRET;        // the whsec_… you copied`,
    ``,
    `app.post('/leados', { rawBody: true }, (request, reply) => {`,
    `  const timestamp = request.headers['x-leados-timestamp'];`,
    `  const presented = String(request.headers['x-leados-signature'] ?? '').replace('v1=', '');`,
    `  // Five minutes either way, so a captured request cannot be replayed tomorrow.`,
    `  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return reply.code(400).send();`,
    ``,
    `  const expected = createHmac('sha256', SECRET)`,
    `    .update(\`\${timestamp}.\${request.rawBody}\`)      // the raw bytes, not a re-serialised object`,
    `    .digest('hex');`,
    `  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'))) {`,
    `    return reply.code(400).send();`,
    `  }`,
    ``,
    `  // Deduplicate on the event id: delivery is at-least-once, by design.`,
    `  enqueue(request.headers['x-leados-event-id'], JSON.parse(request.rawBody));`,
    `  reply.code(200).send();                               // any 2xx means "stop retrying"`,
    `});`,
  ].join('\n');
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/**
 * Throwing, both of them: on a screen whose job is to list endpoints and deliveries, an empty list
 * and a failed request look identical and must not — the product catalogue's permanent silent lie.
 */
export async function loadWebhookEndpoints(
  token: string | null,
): Promise<WebhookEndpointRecord[]> {
  return (await request<WebhookEndpointRecord[]>('/webhooks', { token })).data;
}

export async function loadWebhookDeliveries(
  token: string | null,
  query = '',
): Promise<{ items: WebhookDeliveryRow[]; total: number }> {
  const page = await request<WebhookDeliveryRow[]>(`/webhooks/deliveries${query}`, { token });
  return { items: page.data, total: page.pagination?.total ?? page.data.length };
}
