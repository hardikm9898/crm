import { isValidCustomFieldKey } from './custom-fields.js';

/**
 * The integration framework's vocabulary: which providers exist, what each needs, and how
 * somebody else's field names become ours (Phase 4's "provider registry, credential vault,
 * health checks, generic mapping templates").
 *
 * Pure and tested on its own, for the reason the ingestion and webhook modules give: a mapping
 * applied one way in a preview and another way on the write path is the import's lie in a new
 * place, and a provider catalogue that disagrees with the adapters is a screen offering a button
 * that cannot work.
 */

/** What a connection can do for the workspace. Used by a screen to group, and by a guard to refuse. */
/**
 * What a connection can do for the workspace. Used by a screen to group, and by the inbound
 * pipeline to decide **which** pipeline: a `lead_ingest` delivery becomes a lead through the
 * capture path, and a `messaging` one becomes a conversation and a message. That branch is read
 * from here rather than from the provider's name, so the third messaging provider needs no change
 * to the code that routes it.
 */
export const INTEGRATION_CAPABILITIES = ['lead_ingest', 'email_send', 'messaging'] as const;
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number];

/**
 * How a connection is authenticated.
 *
 * `api_key` — the provider gave the workspace a token we store and send.
 * `shared_secret` — **we** generate a secret and the provider signs its requests with it, which is
 *   the inbound direction and the same HMAC construction the public lead API already verifies.
 *
 * `oauth` is deliberately absent: nothing in this step performs an authorization-code exchange, and
 * a kind no adapter implements is a promise the screen would make on our behalf.
 */
export const INTEGRATION_AUTH_KINDS = ['api_key', 'shared_secret'] as const;
export type IntegrationAuthKind = (typeof INTEGRATION_AUTH_KINDS)[number];

/**
 * How a provider proves an inbound request is really from it.
 *
 * Three, because three real providers verify differently, and a framework that assumed one would
 * have to be reopened for each — the thing a registry exists to avoid.
 *
 * `hmac_header` — a signature over the raw body in a header (ours, and Meta's `X-Hub-Signature-256`).
 * `payload_key` — a shared key **inside** the body, which is what Google Ads lead forms send.
 * `none` — the provider does not post to us at all.
 */
export const INBOUND_VERIFICATIONS = ['hmac_header', 'payload_key', 'none'] as const;
export type InboundVerification = (typeof INBOUND_VERIFICATIONS)[number];

/**
 * A connection's standing, which is the thing a screen is really about.
 *
 * `degraded` exists because "it worked an hour ago and the last probe failed" is neither healthy nor
 * broken, and treating it as broken would make every provider blip a reconnect prompt. `revoked` is
 * the one state a person must act on: the credential is gone and no retry will fix it.
 */
/**
 * What a delivery from this provider **is**, which decides which door it goes through.
 *
 * `events` — the body names its own events, each with the provider's own id. The inbound door
 *   writes a ledger row per event, queues one job each and answers 200 before the work. A delivery
 *   that names **none** (Meta's `page` changes, a WhatsApp status receipt about a message we sent)
 *   is acknowledged and dropped: a 4xx teaches a provider to disable the endpoint, which stops the
 *   deliveries we do want.
 * `single_lead` — the body **is** one lead, with no id of its own, so it is captured inside the
 *   request and deduplicated on `Idempotency-Key`.
 * `none` — the provider does not post to us at all.
 *
 * Declared rather than derived. It was `deliveryIsAReference` that stood in for this question, and
 * the two are different facts that happened to agree: WhatsApp sends the message in full
 * (`deliveryIsAReference: false`) **and** names its own events, so a status-only delivery fell
 * through to the single-lead path and answered 400 at Meta — the near-synonym trap this registry
 * has now paid for twice.
 */
export const INTEGRATION_DELIVERY_SHAPES = ['events', 'single_lead', 'none'] as const;
export type IntegrationDeliveryShape = (typeof INTEGRATION_DELIVERY_SHAPES)[number];

export const INTEGRATION_STATUSES = ['connected', 'degraded', 'error', 'revoked'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/**
 * What a probe found.
 *
 * `unreachable` is ours or the network's — **nothing answered**, so there is no latency to record.
 * `degraded` is the provider answering and refusing to do the work (a 500, a maintenance page):
 * reached, timed, and not working. `unauthorized` is the credential's, and the only one a person
 * has to act on.
 */
export const PROBE_OUTCOMES = ['ok', 'degraded', 'unauthorized', 'unreachable'] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/** One field of a connect form — a setting or a secret. The screen renders both from these. */
export interface ProviderField {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly required: boolean;
}

export interface IntegrationProvider {
  readonly key: string;
  readonly label: string;
  /** One sentence, written for the person deciding whether to connect it. */
  readonly summary: string;
  readonly capabilities: readonly IntegrationCapability[];
  readonly authKind: IntegrationAuthKind;
  /**
   * The **secrets** the connect form asks for, by name.
   *
   * A list rather than one `credential`, because Meta Lead Ads needs two that do different jobs: an
   * app secret to verify a delivery, and a page access token to fetch the lead it refers to. One
   * column holding "the credential" would have made the second one a setting — and a setting is
   * rendered, logged and shown back, which an app secret must never be. Empty when **we** generate
   * the secret (`shared_secret`), because there is nothing for anybody to paste.
   */
  readonly credentialFields: readonly ProviderField[];
  /**
   * The non-secret fields the connect form asks for. Rendered by the screen, so a new provider
   * needs no new UI — which is the whole point of a registry.
   */
  readonly settings: readonly ProviderField[];
  /** Whether a payload this provider sends goes through a field mapping. */
  readonly mappable: boolean;
  /** The mapping a workspace starts with, which they can then edit. */
  readonly defaultMapping: readonly FieldMapping[];
  /** How often the health probe runs, in minutes. Null means "never probed on a schedule". */
  readonly probeEveryMinutes: number | null;
  /** How a delivery from this provider is proved to be from it. */
  readonly inboundVerification: InboundVerification;
  /**
   * Whether a delivery is only a **reference** to the lead.
   *
   * Meta sends a `leadgen_id` and nothing else, so the lead has to be fetched with the stored
   * token; Google Ads sends the answers. It is declared here rather than inferred per payload,
   * because a provider that sometimes sends the lead and sometimes a reference would be two
   * providers.
   */
  readonly deliveryIsAReference: boolean;
  /** What a delivery from this provider is, and therefore which inbound door it goes through. */
  readonly deliveryShape: IntegrationDeliveryShape;
}

/**
 * The lead fields a mapping may write to.
 *
 * Taken from the public capture schema rather than from the lead table: those are the fields a
 * stranger's payload is allowed to set, and a mapping that could write `score` or `assignedUserId`
 * would be an integration deciding what the workspace's own rules decide.
 */
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
  /**
   * The enquiry's own value, in **minor units**, which an ad platform's budget question often is.
   *
   * It is here and `score`, `assignedUserId` and `status` are not, and the line between them is
   * the one that matters: this is something the person enquiring told us, and those are things the
   * workspace's own rules decide. A mapping that could write them would be an integration
   * overruling the assignment engine and the scoring rules from somebody else's config file.
   */
  'valueMinor',
] as const;
export type MappableLeadField = (typeof MAPPABLE_LEAD_FIELDS)[number];

/**
 * What a value can be put through on the way in.
 *
 * Deliberately few, and each one earns its place from a real provider's habits: ad platforms send
 * `Full Name` as one field, phone numbers arrive with spaces and brackets, and a "yes"/"no" answer
 * is a string that means a boolean. Anything more than this is a transformation language, and a
 * transformation language in a JSONB column is a program nobody can review.
 */
export const MAPPING_TRANSFORMS = [
  'none',
  'trim',
  'lowercase',
  'digits',
  'phone',
  'boolean',
] as const;
export type MappingTransform = (typeof MAPPING_TRANSFORMS)[number];

export interface FieldMapping {
  /** The provider's own name for it, as a dot path: `field_data.full_name`. */
  readonly source: string;
  /** Ours: a capture field, or `custom.<key>`. */
  readonly target: string;
  readonly transform?: MappingTransform;
}

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  {
    key: 'generic_webhook',
    label: 'Any webhook',
    summary:
      'Let another system post leads here with whatever field names it already uses. We sign-check each request and map its fields onto yours.',
    capabilities: ['lead_ingest'],
    // We generate the secret: the sender signs with it, exactly as the public lead API's callers do.
    authKind: 'shared_secret',
    credentialFields: [],
    settings: [
      {
        key: 'sourceName',
        label: 'Call these leads',
        hint: 'The source name that appears on every lead this connection brings in — "Partner site", "Agency".',
        required: false,
      },
    ],
    mappable: true,
    // Empty on purpose: a default mapping for "any webhook" would be a guess about somebody else's
    // field names, and a wrong guess silently drops the fields it did not expect.
    defaultMapping: [],
    probeEveryMinutes: null,
    inboundVerification: 'hmac_header',
    deliveryIsAReference: false,
    deliveryShape: 'single_lead',
  },
  {
    key: 'postmark',
    label: 'Postmark',
    summary:
      'The service that delivers this workspace’s email — verifications, invitations, resets and notifications.',
    capabilities: ['email_send'],
    authKind: 'api_key',
    credentialFields: [
      {
        key: 'serverToken',
        label: 'Server API token',
        hint: 'Postmark → your server → API Tokens. A long identifier, not your account password.',
        required: true,
      },
    ],
    settings: [
      {
        key: 'fromAddress',
        label: 'Send from',
        hint: 'The verified sender address Postmark will accept.',
        required: true,
      },
      {
        key: 'messageStream',
        label: 'Message stream',
        hint: 'Postmark’s stream id. "outbound" unless you made another.',
        required: false,
      },
    ],
    mappable: false,
    defaultMapping: [],
    // Ten minutes, the cadence §5 of the queue document already gives
    // `integration.health-check`: often enough that a revoked token is a prompt within the hour,
    // rare enough that a hundred workspaces do not become a hundred requests a minute.
    probeEveryMinutes: 10,
    inboundVerification: 'none',
    deliveryIsAReference: false,
    deliveryShape: 'none',
  },
  {
    key: 'meta_lead_ads',
    label: 'Meta Lead Ads',
    summary:
      'Leads from your Facebook and Instagram lead forms, the moment somebody submits one — with the answers they gave, on their lead record here.',
    capabilities: ['lead_ingest'],
    // Two secrets, doing two jobs. The app secret proves a delivery is Meta's; the page token
    // fetches the lead Meta only refers to. Neither is a setting, because a setting is rendered
    // back to the screen.
    authKind: 'api_key',
    credentialFields: [
      {
        key: 'appSecret',
        label: 'App secret',
        hint: 'Meta for Developers → your app → Settings → Basic → App Secret. We check every delivery’s signature against it.',
        required: true,
      },
      {
        key: 'pageAccessToken',
        label: 'Page access token',
        hint: 'A long-lived token for the Page the form belongs to, with leads_retrieval. Meta sends us only an id; this is what fetches the answers.',
        required: true,
      },
    ],
    settings: [
      {
        key: 'pageId',
        label: 'Page id',
        hint: 'The numeric id of the Facebook Page. Shown on the connection and used for the health check.',
        required: true,
      },
      {
        key: 'verifyToken',
        label: 'Verify token',
        hint: 'Any phrase you choose. Meta echoes it once when you add the callback URL, and we answer only if it matches.',
        required: false,
      },
      {
        key: 'sourceName',
        label: 'Call these leads',
        hint: 'The source name that appears on every lead this connection brings in — "Facebook", "Instagram".',
        required: false,
      },
    ],
    mappable: true,
    /**
     * Meta's own field names, so the connection works the moment it is made.
     *
     * Unlike "any webhook", this **is** knowable: `full_name`, `phone_number` and `email` are
     * Meta's standard lead-form questions, and a workspace that asks custom questions edits the
     * mapping rather than starting from nothing. The adapter flattens `field_data` to these keys
     * before the mapping runs, which is what makes a dot path enough.
     */
    defaultMapping: [
      { source: 'full_name', target: 'name', transform: 'trim' },
      { source: 'phone_number', target: 'phone', transform: 'phone' },
      { source: 'email', target: 'email', transform: 'lowercase' },
      { source: 'city', target: 'city', transform: 'trim' },
      { source: 'company_name', target: 'company', transform: 'trim' },
    ],
    probeEveryMinutes: 10,
    inboundVerification: 'hmac_header',
    // Meta sends a `leadgen_id`. The lead itself is a second request, with the page token.
    deliveryIsAReference: true,
    deliveryShape: 'events',
  },
  {
    key: 'whatsapp_cloud',
    label: 'WhatsApp',
    summary:
      'Your WhatsApp Business number, so a customer’s message arrives here as a conversation beside everything else you know about them.',
    capabilities: ['messaging'],
    // Two secrets again, and for the same two jobs as Meta Lead Ads: the app secret proves a
    // delivery is Meta's, and the access token reaches the Graph API to read the business and
    // (from the next step) to send.
    authKind: 'api_key',
    credentialFields: [
      {
        key: 'appSecret',
        label: 'App secret',
        hint: 'Meta for Developers → your app → Settings → Basic → App Secret. We check every delivery’s signature against it.',
        required: true,
      },
      {
        key: 'accessToken',
        label: 'System user access token',
        hint: 'A permanent token for the WhatsApp Business Account, with whatsapp_business_messaging and whatsapp_business_management.',
        required: true,
      },
    ],
    settings: [
      {
        key: 'wabaId',
        label: 'WhatsApp Business Account id',
        hint: 'Meta Business Suite → WhatsApp Accounts. The numbers on it are discovered for you.',
        required: true,
      },
      {
        key: 'verifyToken',
        label: 'Verify token',
        hint: 'Any phrase you choose. Meta echoes it once when you add the callback URL, and we answer only if it matches.',
        required: false,
      },
    ],
    // A WhatsApp message is a **conversation**, not a lead capture: the pipeline creates the lead
    // itself when nobody recognises the number, so there is no field mapping to write and offering
    // one would be a screen promising something nothing reads.
    mappable: false,
    defaultMapping: [],
    probeEveryMinutes: 10,
    inboundVerification: 'hmac_header',
    deliveryIsAReference: false,
    deliveryShape: 'events',
  },
  {
    key: 'google_ads_leads',
    label: 'Google Ads lead forms',
    summary:
      'Leads from your Google Ads lead form extensions, posted here as each one is submitted, with the answers the person gave.',
    capabilities: ['lead_ingest'],
    // Google Ads asks *you* for a webhook key and echoes it in every payload, so we generate it —
    // the same arrangement as "any webhook", with the key in the body rather than in a signature.
    authKind: 'shared_secret',
    credentialFields: [],
    settings: [
      {
        key: 'sourceName',
        label: 'Call these leads',
        hint: 'The source name that appears on every lead this connection brings in — "Google Ads".',
        required: false,
      },
    ],
    mappable: true,
    /**
     * Google's own column ids, which arrive upper-cased in `user_column_data`.
     *
     * `FULL_NAME`, `PHONE_NUMBER`, `EMAIL`, `CITY` and `COMPANY_NAME` are the standard questions a
     * lead form extension offers; the adapter flattens the array to these keys, so a workspace that
     * adds a custom question maps one more row rather than rewriting this.
     */
    defaultMapping: [
      { source: 'FULL_NAME', target: 'name', transform: 'trim' },
      { source: 'PHONE_NUMBER', target: 'phone', transform: 'phone' },
      { source: 'EMAIL', target: 'email', transform: 'lowercase' },
      { source: 'CITY', target: 'city', transform: 'trim' },
      { source: 'COMPANY_NAME', target: 'company', transform: 'trim' },
    ],
    // Nothing to probe: Google posts to us, and the key it posts with is one we generated. The
    // connection is healthy when something arrives, which is `last_success_at`.
    probeEveryMinutes: null,
    inboundVerification: 'payload_key',
    deliveryIsAReference: false,
    deliveryShape: 'events',
  },
];

export function findProvider(key: string): IntegrationProvider | undefined {
  return INTEGRATION_PROVIDERS.find((provider) => provider.key === key);
}

export const INTEGRATION_PROVIDER_KEYS = INTEGRATION_PROVIDERS.map((provider) => provider.key);

/** Whether a target names something a mapping is allowed to write. */
export function isMappableTarget(target: string): boolean {
  if ((MAPPABLE_LEAD_FIELDS as readonly string[]).includes(target)) return true;
  if (!target.startsWith('custom.')) return false;
  return isValidCustomFieldKey(target.slice('custom.'.length));
}

export interface FieldMappingProblem {
  readonly index: number;
  readonly message: string;
}

/**
 * What is wrong with a mapping, in the words of somebody editing it.
 *
 * Returned rather than thrown so the screen can show every problem at once: a mapping with four
 * mistakes corrected one refusal at a time is four round trips.
 */
export function mappingProblems(mapping: readonly FieldMapping[]): FieldMappingProblem[] {
  const problems: FieldMappingProblem[] = [];
  const seen = new Map<string, number>();

  mapping.forEach((entry, index) => {
    if (entry.source.trim().length === 0) {
      problems.push({ index, message: 'Name the field the other system sends.' });
    }
    if (!isMappableTarget(entry.target)) {
      problems.push({
        index,
        message: `“${entry.target}” is not a field a connection may write. Use one of the lead fields, or custom.<key> for one of your own.`,
      });
    }
    if (entry.transform && !(MAPPING_TRANSFORMS as readonly string[]).includes(entry.transform)) {
      problems.push({
        index,
        message: `“${entry.transform}” is not something we can do to a value.`,
      });
    }
    const previous = seen.get(entry.target);
    if (previous !== undefined) {
      // Two sources writing one target is not a merge: the last one wins silently, which is the
      // kind of mapping somebody debugs for an afternoon.
      problems.push({
        index,
        message: `Two fields both write to “${entry.target}” — the one lower down would quietly win.`,
      });
    } else {
      seen.set(entry.target, index);
    }
  });

  return problems;
}

export interface MappingResult {
  /** The payload as our capture endpoint would accept it. */
  readonly mapped: Record<string, unknown>;
  /** Source paths the mapping named and the payload did not carry. */
  readonly missing: readonly string[];
  /**
   * Top-level keys the payload carried that no mapping entry named.
   *
   * Kept rather than counted, and **passed through** onto the capture: the one-click custom field
   * (`FR-CAP-5`) is what turns one of these into a field of its own, and a mapping that dropped
   * them would make that feature unreachable for every mapped provider.
   */
  readonly unmapped: readonly string[];
}

/**
 * Somebody else's payload, as our own.
 *
 * Dot paths, because every ad platform nests (`field_data.full_name`); an array index is a number
 * segment (`answers.0.value`). A source the payload does not carry is **reported, not invented** —
 * `missing` is what a screen shows when a mapping was written against last month's payload.
 */
export function applyFieldMapping(
  payload: Record<string, unknown>,
  mapping: readonly FieldMapping[],
): MappingResult {
  const mapped: Record<string, unknown> = {};
  const missing: string[] = [];
  const named = new Set<string>();

  for (const entry of mapping) {
    named.add(entry.source.split('.')[0] ?? entry.source);
    const raw = readPath(payload, entry.source);
    if (raw === undefined || raw === null || raw === '') {
      missing.push(entry.source);
      continue;
    }
    const value = transform(raw, entry.transform ?? 'none');
    if (value === undefined) {
      missing.push(entry.source);
      continue;
    }
    assign(mapped, entry.target, value);
  }

  const unmapped = Object.keys(payload).filter((key) => !named.has(key));
  return { mapped, missing, unmapped };
}

function readPath(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function assign(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!path.startsWith('custom.')) {
    target[path] = value;
    return;
  }
  // A custom value belongs under `customFields`, which is where the capture endpoint reads it and
  // where `customFieldKeyFor` has already put the one-click field's key.
  const custom = (target['customFields'] as Record<string, unknown> | undefined) ?? {};
  custom[path.slice('custom.'.length)] = value;
  target['customFields'] = custom;
}

function transform(value: unknown, kind: MappingTransform): unknown {
  const text =
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : value;
  switch (kind) {
    case 'trim':
      return typeof text === 'string' ? text.trim() : text;
    case 'lowercase':
      return typeof text === 'string' ? text.trim().toLowerCase() : text;
    case 'digits':
      return typeof text === 'string' ? text.replace(/\D+/g, '') : text;
    case 'phone': {
      // Keeps the `+` and drops everything else: the normaliser downstream needs the workspace's
      // country to finish the job, and this only has to stop `(+91) 98450-12345` arriving as prose.
      // The brackets come off **before** the plus is looked for — a test caught the version that
      // checked the first character and threw the country code away.
      if (typeof text !== 'string') return text;
      const cleaned = text.replace(/[^\d+]/g, '');
      return `${cleaned.startsWith('+') ? '+' : ''}${cleaned.replace(/\D+/g, '')}`;
    }
    case 'boolean':
      return typeof text === 'string' ? TRUTHY.has(text.trim().toLowerCase()) : Boolean(text);
    default:
      return text;
  }
}

const TRUTHY = new Set(['true', 'yes', 'y', '1', 'on', 'agreed', 'accepted']);

/**
 * What a probe's outcome means for the connection's standing.
 *
 * One function, because three callers would otherwise each decide — and the transition that matters
 * is the one a person has to act on: `unauthorized` is `revoked`, immediately and without a grace
 * period, because no number of retries fixes a credential somebody deleted.
 *
 * The other two failures **escalate rather than decide**: one is `degraded`, a second in a row is
 * `error`. A provider's bad minute is not a workspace's broken integration; a provider's bad hour
 * is. They escalate identically because the difference between them is diagnostic and not a
 * severity — `unreachable` is "nothing answered", so it carries no latency, and `degraded` is "it
 * answered and refused", so it carries one. Treating "answered 500 twice" as permanently
 * recoverable would leave a connection reading "nothing to do yet" all afternoon.
 */
export function nextStatus(current: IntegrationStatus, outcome: ProbeOutcome): IntegrationStatus {
  if (outcome === 'ok') return 'connected';
  if (outcome === 'unauthorized') return 'revoked';
  return current === 'degraded' || current === 'error' ? 'error' : 'degraded';
}

// ── Provider payload shapes ─────────────────────────────────────────────────

/**
 * Meta's `field_data` as a flat object.
 *
 * Meta sends `[{ name: 'full_name', values: ['Asha Rao'] }]` — an array of question/answer pairs,
 * which a dot path cannot address by name and which would otherwise force every mapping to be
 * written as `field_data.0.values.0`: an index that moves the day somebody reorders the form's
 * questions. Flattening by `name` is what makes `full_name` a stable source, and it is why the
 * provider's `defaultMapping` can be written at all.
 *
 * A question answered more than once (a checkbox group) keeps **all** its values, joined by a
 * comma: taking the first silently discards an answer somebody gave, and a mapping that wanted one
 * value can still read it.
 */
export function flattenMetaFieldData(payload: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...payload };
  const entries = payload['field_data'];
  if (!Array.isArray(entries)) return flat;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const name = (entry as { name?: unknown }).name;
    const values = (entry as { values?: unknown }).values;
    if (typeof name !== 'string' || name === '') continue;
    const list = Array.isArray(values)
      ? values.filter((value) => value !== null && value !== undefined)
      : [];
    if (list.length === 0) continue;
    flat[name] = list.length === 1 ? list[0] : list.map((value) => String(value)).join(', ');
  }
  return flat;
}

/**
 * Google Ads' `user_column_data` as a flat object.
 *
 * Google sends `[{ column_id: 'FULL_NAME', string_value: 'Asha Rao' }]`, and `column_name` beside
 * it for a custom question. The **id** is the key, because it is the stable one: `column_name` is
 * the question's wording and changes when somebody edits the form. A custom question has no
 * standard id, so its name is used — which is the only case where a mapping can break on an edit,
 * and the one Google gives no alternative for.
 */
export function flattenGoogleColumnData(payload: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...payload };
  const entries = payload['user_column_data'];
  if (!Array.isArray(entries)) return flat;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as { column_id?: unknown; column_name?: unknown; string_value?: unknown };
    const key =
      typeof row.column_id === 'string' && row.column_id !== ''
        ? row.column_id
        : typeof row.column_name === 'string' && row.column_name !== ''
          ? row.column_name
          : null;
    if (key === null) continue;
    if (row.string_value === null || row.string_value === undefined || row.string_value === '')
      continue;
    flat[key] = row.string_value;
  }
  return flat;
}

/** Whether this standing needs a person, as opposed to time. */
export function needsReconnect(status: IntegrationStatus): boolean {
  return status === 'revoked';
}

/** The sentence a screen puts beside a connection. */
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
