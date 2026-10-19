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
export const INTEGRATION_CAPABILITIES = ['lead_ingest', 'email_send'] as const;
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
 * A connection's standing, which is the thing a screen is really about.
 *
 * `degraded` exists because "it worked an hour ago and the last probe failed" is neither healthy nor
 * broken, and treating it as broken would make every provider blip a reconnect prompt. `revoked` is
 * the one state a person must act on: the credential is gone and no retry will fix it.
 */
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

export interface IntegrationProvider {
  readonly key: string;
  readonly label: string;
  /** One sentence, written for the person deciding whether to connect it. */
  readonly summary: string;
  readonly capabilities: readonly IntegrationCapability[];
  readonly authKind: IntegrationAuthKind;
  /**
   * The fields the connect form asks for, beyond the secret itself. Rendered by the screen, so a
   * new provider needs no new UI — which is the whole point of a registry.
   */
  readonly settings: readonly {
    readonly key: string;
    readonly label: string;
    readonly hint?: string;
    readonly required: boolean;
  }[];
  /** Whether a payload this provider sends goes through a field mapping. */
  readonly mappable: boolean;
  /** The mapping a workspace starts with, which they can then edit. */
  readonly defaultMapping: readonly FieldMapping[];
  /** How often the health probe runs, in minutes. Null means "never probed on a schedule". */
  readonly probeEveryMinutes: number | null;
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
export const MAPPING_TRANSFORMS = ['none', 'trim', 'lowercase', 'digits', 'phone', 'boolean'] as const;
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
  },
  {
    key: 'postmark',
    label: 'Postmark',
    summary:
      'The service that delivers this workspace’s email — verifications, invitations, resets and notifications.',
    capabilities: ['email_send'],
    authKind: 'api_key',
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
      problems.push({ index, message: `“${entry.transform}” is not something we can do to a value.` });
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
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : value;
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
export function nextStatus(
  current: IntegrationStatus,
  outcome: ProbeOutcome,
): IntegrationStatus {
  if (outcome === 'ok') return 'connected';
  if (outcome === 'unauthorized') return 'revoked';
  return current === 'degraded' || current === 'error' ? 'error' : 'degraded';
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
