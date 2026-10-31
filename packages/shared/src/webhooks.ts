import { newToken } from './ids.js';
import { signaturePayload } from './ingestion.js';
import { createHmac } from 'node:crypto';

/**
 * Outbound webhooks (`FR-API-4`, `docs/api-architecture.md` §8).
 *
 * The other direction of the public lead API: this product posting to somebody else's server. The
 * vocabulary lives here because four things must agree — the fan-out that decides which endpoints
 * want an event, the sender that signs it, the settings screen that offers the event types, and the
 * snippet that screen shows a developer for verifying the signature. A list that differs anywhere
 * is an endpoint subscribed to something that never arrives.
 *
 * The signature is the **same construction** as the inbound one (`signaturePayload`): an
 * HMAC-SHA256 over `"<unix seconds>.<raw body>"`. One definition, so a client implementing both
 * directions implements it once — and so neither half can drift into being the odd one out.
 */

// ── Event types ─────────────────────────────────────────────────────────────

/**
 * Every event an endpoint may subscribe to.
 *
 * This is **what the product actually emits**, not §8's wish list. A screen offering
 * `conversation.created` before Phase 5 exists is a tick box that can only ever disappoint, and an
 * endpoint subscribed to it would look healthy while receiving nothing. Where §8 and the product
 * disagree about a name the product wins and the amendment is written down: there is no
 * `payment.completed` (money arrives as `payment.received` and leaves as `payment.refunded`) and no
 * `form.submitted` (a form's capture *is* a `lead.created`, through the one ingestion path, so a
 * second event for it would double every consumer's work).
 *
 * `message.*`, `conversation.*`, `automation.failed` and `integration.failed` arrive with the
 * phases that emit them.
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

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The ping an endpoint receives when somebody presses "send a test".
 *
 * A reserved type rather than a real one: an endpoint cannot subscribe to it (it is not in the list
 * above) and always receives its own test, because "did anything arrive at all" is the first
 * question a developer wiring this up asks, and answering it should not require creating a lead.
 */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

/** What became of a delivery. `pending` is the state it is written in, before any attempt. */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'exhausted'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

// ── Delivery policy ─────────────────────────────────────────────────────────

/**
 * The retry schedule §8 names: 10 s, 1 m, 5 m, 30 m, 2 h, 6 h, 24 h.
 *
 * Seven entries, so a delivery that fails every time is attempted eight times over about 33 hours
 * and then marked `exhausted` — an endpoint that has been down for a day and a half is not coming
 * back inside this delivery's lifetime, and the delivery log plus a manual retry is the honest
 * answer after that.
 */
export const RETRY_SCHEDULE_SECONDS = [10, 60, 300, 1_800, 7_200, 21_600, 86_400] as const;

/** `FR-API-4`'s auto-disable threshold, counted on **consecutive** failures. */
export const MAX_CONSECUTIVE_FAILURES = 15;

/** §8's 10 s ceiling. A customer's slow endpoint must not hold a worker. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * How much of the response body is kept per attempt.
 *
 * Enough to show a developer the error their own server returned, and bounded because a delivery
 * log is not a mirror of somebody else's HTML error page.
 */
export const RESPONSE_BODY_LIMIT = 2_000;

/**
 * When the next attempt is due, with jitter.
 *
 * `attemptNo` is the number of attempts **already made** (1 after the first failure). The jitter is
 * ±20 %, applied so a hundred endpoints that all failed during the same outage do not all come back
 * in the same second — the retry storm that turns somebody's brief outage into a second one.
 *
 * `null` means the schedule is spent: the delivery is `exhausted` and only a person can retry it.
 */
export function nextAttemptAt(
  attemptNo: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date | null {
  const base = RETRY_SCHEDULE_SECONDS[attemptNo - 1];
  if (base === undefined) return null;
  const jitter = 1 + (random() * 0.4 - 0.2);
  return new Date(now.getTime() + Math.round(base * jitter * 1_000));
}

/** How many attempts a delivery gets before it is spent, including the first. */
export const MAX_DELIVERY_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;

/**
 * Whether the endpoint's answer counts as delivered.
 *
 * Any 2xx is success, as §8 says. Everything else is a failure — including a 3xx, because a
 * redirect is not an acknowledgement and following one is how a signed request ends up at an
 * address the SSRF check never saw.
 */
export function isDeliveredStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * `410 Gone` is the one answer that disables an endpoint immediately (§8).
 *
 * It is the only status that means "stop, permanently, this is not a mistake" — a 404 is a
 * deployment that has not finished and a 500 is a bad afternoon, and disabling on either would cost
 * a workspace its integration over a blip.
 */
export function isPermanentRejection(status: number): boolean {
  return status === 410;
}

// ── The credential ──────────────────────────────────────────────────────────

/**
 * A signing secret, prefixed so a leaked one is recognisable in a log or a paste.
 *
 * Stored **encrypted** rather than hashed, for the reason ADR-0030 gives about the inbound
 * direction: signing needs the secret itself, so a digest could not produce a signature. Shown to
 * the workspace once, like an API key's secret.
 */
export function generateWebhookSecret(): string {
  return `whsec_${newToken(24)}`;
}

/** The value of `X-LeadOS-Signature`. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(signaturePayload(timestamp, rawBody)).digest('hex')}`;
}

/**
 * The headers §8 specifies, built in one place.
 *
 * A sender that assembled these inline is a sender whose header names can drift from the ones the
 * documentation tells a developer to read — and the delivery id is what makes a retry recognisable
 * as the same delivery rather than a second event.
 */
export function webhookHeaders(input: {
  readonly eventType: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly timestamp: number;
  readonly signature: string;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': 'LeadOS-Webhooks/1',
    'x-leados-event': input.eventType,
    'x-leados-event-id': input.eventId,
    'x-leados-delivery-id': input.deliveryId,
    'x-leados-timestamp': String(input.timestamp),
    'x-leados-signature': input.signature,
  };
}

/**
 * The body, as §8 publishes it.
 *
 * `data` is the **event's own payload**, not a rendered resource. A webhook is a notification that
 * something happened, and the REST API is the single source of truth for what the thing looks like
 * now — the same argument §10 makes for realtime deltas. Embedding a full lead would also mean
 * every consumer reading a snapshot that was already stale when it was signed.
 */
export function buildWebhookPayload(input: {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly organizationId: string;
  readonly data: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: input.eventId,
    type: input.type,
    occurredAt: input.occurredAt.toISOString(),
    organizationId: input.organizationId,
    apiVersion: 'v1',
    data: input.data,
  };
}

// ── Where a webhook may be sent (SSRF) ──────────────────────────────────────

/**
 * Why this is here at all.
 *
 * An outbound webhook is a URL a **tenant** chooses and our server fetches, which is the textbook
 * server-side request forgery primitive: `http://169.254.169.254/latest/meta-data/` returns cloud
 * credentials, `http://localhost:5432` is the database, and a signed POST from inside the network
 * is a request every internal service trusts. So the URL is classified here (hostname and literal
 * address), and the API checks the **resolved** addresses as well — a hostname that resolves to
 * 127.0.0.1 is the same attack wearing a hat, and DNS is not something this package can do.
 */
export type UrlRefusal =
  'not_a_url' | 'scheme' | 'credentials' | 'port' | 'blocked_host' | 'blocked_address';

export interface UrlVerdict {
  readonly ok: boolean;
  readonly reason?: UrlRefusal;
  readonly hostname?: string;
}

/** The sentence a person reads when their URL is refused. Keyed so the API need not invent one. */
export const URL_REFUSAL_MESSAGES: Record<UrlRefusal, string> = {
  not_a_url: 'That is not a URL we can post to.',
  scheme: 'Use an https:// address.',
  credentials: 'Put the credentials in a header your endpoint checks, not in the URL.',
  port: 'A webhook endpoint has to be https on the standard port (443).',
  blocked_host:
    'That address is inside a private network, so our servers cannot reach it — use a public URL.',
  blocked_address:
    'That hostname resolves to a private or link-local address, which we will not post to.',
};

/** Hostnames refused outright, before anything is resolved. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa'];
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/**
 * Whether a literal IP address is one we refuse to post to.
 *
 * Deliberately a allow-nothing list of ranges rather than a "is it public" lookup: the ranges are
 * stable, and the failure mode of getting it wrong is an SSRF, so the check errs towards refusing.
 */
export function isBlockedAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (value === '') return true;

  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is the classic way past a v4-only check.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);

  if (value.includes(':')) {
    if (value === '::' || value === '::1') return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10), including the v6 metadata address.
    if (/^f[cd][0-9a-f]{0,2}:/.test(value)) return true;
    if (/^fe[89ab][0-9a-f]?:/.test(value)) return true;
    if (value.startsWith('fe80:')) return true;
    return false;
  }

  const parts = value.split('.');
  if (parts.length !== 4) return true;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 and 192.0.2.0/24 (documentation)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved, including 255.255.255.255
  return false;
}

/**
 * Whether a hostname is refused before resolution.
 *
 * A literal address is classified as one; a name is refused only for the handful of suffixes that
 * cannot be anything but internal. Everything else has to be resolved, which is the API's job.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return isBlockedAddress(host);
  return false;
}

/**
 * The static half of the check: what can be decided from the URL text alone.
 *
 * `allowInsecure` exists for development, where an endpoint under test is an `http://localhost`
 * one — and it is a **deployment** decision rather than a per-endpoint field, because a tenant who
 * could tick "allow http" could ask us to post a signed payload over the open internet in clear.
 */
export function classifyWebhookUrl(
  raw: string,
  options: { readonly allowInsecure?: boolean } = {},
): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }

  const insecureAllowed = options.allowInsecure === true;
  if (url.protocol !== 'https:' && !(insecureAllowed && url.protocol === 'http:')) {
    return { ok: false, reason: 'scheme' };
  }
  // Credentials in the URL would be sent to the endpoint by us, and stored by us in plain text.
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };

  // Production: https on 443 and nothing else, so an endpoint cannot be aimed at a database
  // (5432), a cache (6379) or an ssh daemon by a workspace that fancies trying. Development: any
  // port, because `allowInsecure` already means "this deployment may post to the machine it is
  // running on", and a test receiver listens on whatever port the operating system hands it.
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const portAllowed = insecureAllowed ? port >= 1 && port <= 65_535 : port === 443;
  if (!portAllowed) return { ok: false, reason: 'port' };

  if (isBlockedHost(url.hostname) && !insecureAllowed) {
    return { ok: false, reason: 'blocked_host', hostname: url.hostname };
  }
  return { ok: true, hostname: url.hostname };
}
