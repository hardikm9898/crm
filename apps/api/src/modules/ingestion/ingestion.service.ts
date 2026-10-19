import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  applyFieldMapping,
  buildDisplayName,
  customFieldKeyFor,
  dedupeHash,
  derivedIdempotencyKey,
  newId,
  normalizeContactNumbers,
  normalizeUtm,
  splitFullName,
  systemPrincipal,
  tenantContext,
  unmappedKeys,
  validateCustomValues,
  withPlatformScope,
  type CountryCode,
  type FieldMapping,
  type IngestChannel,
  type IngestionStage,
} from '@leados/shared';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { requestStore } from '../../infra/http/request-store.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import { LeadsService } from '../leads/leads.service.js';
import type { PublicLeadInput } from './ingestion.dto.js';
import { publicLeadSchema } from './ingestion.dto.js';

/** How long a stored response answers a replay. Long enough for a client's retries, not forever. */
const IDEMPOTENCY_TTL_HOURS = 48;

/** The endpoint an idempotency key is scoped to, so the same key elsewhere is a different key. */
const PUBLIC_LEAD_ENDPOINT = 'POST /public/leads';

/**
 * Who a capture is attributed to, which is as much as this pipeline needs to know about the caller.
 *
 * Narrower than `AuthenticatedCaller` on purpose: the public lead API authenticates a key, an
 * integration connection authenticates a signature against a secret we minted, and a third door
 * will authenticate something else again. What they have in common is a workspace and, sometimes, a
 * credential row — and a pipeline that took the whole authenticated caller could not be reached by
 * the second door without inventing an API key for it.
 */
export interface CaptureAttribution {
  readonly organizationId: string;
  readonly apiKeyRowId: string | null;
}

/** What `capture` needs beyond the payload, and what each door varies. */
export interface CaptureOptions {
  /** The bytes the signature was computed over. Hashed for the dedupe key, never re-serialised. */
  readonly rawBody: string;
  readonly idempotencyKey: string | undefined;
  readonly headers: Record<string, string>;
  /** Which door. Defaults to the public lead API's own. */
  readonly channel?: IngestChannel;
  /** The endpoint an idempotency key is scoped to. One per door, or two doors share a key space. */
  readonly endpoint?: string;
  /** The connection that brought it in, when a provider did rather than a key. */
  readonly integrationConnectionId?: string | null;
  /**
   * The sender's field names mapped onto ours, applied **inside** this pipeline.
   *
   * Here rather than at the caller, because the stored payload must be what arrived — the
   * never-lose store is worthless if it holds our interpretation of somebody's payload rather than
   * their payload — and because the mapped result then goes through the same `publicLeadSchema`
   * and the same mapper as every other capture.
   */
  readonly mapping?: readonly FieldMapping[];
  /** Values a connection supplies when the payload does not, such as its own source name. */
  readonly defaults?: Record<string, unknown>;
}

/** What a capture answers, whether it was accepted now or replayed from before. */
export interface IngestResult {
  readonly status: 'created' | 'duplicate_attached' | 'replayed';
  readonly leadId: string;
  readonly duplicateOf: string | null;
  readonly assignedTo: { id: string; name: string | null } | null;
  readonly unmappedFields: readonly string[];
  readonly payloadId: string;
}

/**
 * The public lead API's pipeline (`FR-CAP-3`, `FR-CAP-4`, `FR-CAP-5`, `FR-API-5`).
 *
 * Five decisions, each of which has a wrong answer that looks reasonable:
 *
 *  * **The raw body is stored before anything else happens**, in its own transaction, so a 5xx can
 *    never mean a lost lead. A row written once the outcome is known is exactly the row that is
 *    missing when the capture failed — which is the one case `FR-CAP-3` exists for, and which the
 *    form endpoint already paid for when a cold start blew the five-second transaction limit.
 *  * **A replay answers the first response**, byte for byte, including the lead id. A client that
 *    retried because it never saw the answer must not create a second lead, and must not be told
 *    "duplicate" either — it is owed the answer it missed (`FR-API-5`). A replay of the same key
 *    with a *different* body is a client bug and answers 409 rather than quietly returning the
 *    first lead.
 *  * **The capture goes through `LeadsService.create`**, like the form and the import, so
 *    duplicate detection, scoring, assignment, the SLA clock, the timeline and the events all
 *    happen exactly as they do everywhere else.
 *  * **Unknown fields are kept and named**, never refused (`FR-CAP-5`): the whole payload is in
 *    `raw_body`, and the keys this API does not understand come back in the response and are
 *    counted on the ingestion screen, where one click turns one into a custom field.
 *  * **Every failure writes an `ingestion_errors` row naming the stage**, because "why did my lead
 *    not appear" has to be answerable by the tenant rather than by reading our logs.
 */
@Injectable()
export class IngestionService {
  constructor(
    private readonly db: DbService,
    private readonly leads: LeadsService,
    private readonly fields: FieldRegistryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * A capture from the public API.
   *
   * `caller` has already been authenticated; `rawBody` is the bytes the signature was computed
   * over, and the parsed payload is what the mapper reads.
   */
  async capture(
    caller: CaptureAttribution,
    payload: Record<string, unknown>,
    options: CaptureOptions,
  ): Promise<IngestResult> {
    const request = requestStore.get();
    const channel: IngestChannel = options.channel ?? 'public_api';
    const endpoint = options.endpoint ?? PUBLIC_LEAD_ENDPOINT;
    const key = options.idempotencyKey?.trim() || derivedIdempotencyKey(channel, options.rawBody);
    const requestHash = dedupeHash(options.rawBody);

    // ── A replay, answered before anything is written again ─────────────────
    const replay = await this.inTenant(caller.organizationId, async () =>
      this.db.client.idempotencyKey.findFirst({
        where: { endpoint, key },
      }),
    );
    if (replay) {
      if (replay.requestHash !== requestHash) {
        // Returning the first answer to a different request would be worse than refusing: the
        // client believes its second lead exists.
        throw new AppError(
          'IDEMPOTENT_REPLAY_MISMATCH',
          'That Idempotency-Key was already used for a different payload. Use a new key for a new lead.',
          409,
        );
      }
      const body = replay.responseBody as { leadId?: string; payloadId?: string } | null;
      this.logger.info({ key, leadId: body?.leadId }, 'public lead API replay answered');
      return {
        status: 'replayed',
        leadId: String(body?.leadId ?? ''),
        duplicateOf: null,
        assignedTo: null,
        unmappedFields: [],
        payloadId: String(body?.payloadId ?? ''),
      };
    }

    // ── The never-lose store, written first ─────────────────────────────────
    const payloadId = newId();
    const receivedAt = new Date();
    await this.inTenant(caller.organizationId, async () => {
      await this.db.client.inboundPayload.create({
        data: {
          id: payloadId,
          organizationId: caller.organizationId,
          channel,
          apiKeyId: caller.apiKeyRowId,
          integrationConnectionId: options.integrationConnectionId ?? null,
          // Exactly what arrived, in the sender's own field names. The mapping is applied below,
          // to a copy: a never-lose store holding our interpretation of a payload cannot answer
          // "what did they actually send us", which is the only question it exists for.
          rawBody: payload as never,
          headers: options.headers as never,
          // The signature was verified before this method was reached; recorded so a payload read
          // a month later says whether it was signed rather than leaving it to be inferred.
          signatureValid: true,
          idempotencyKey: key,
          dedupeHash: requestHash,
          status: 'received',
          ipHash: this.hashIp(request?.ip),
          userAgent: request?.userAgent ?? null,
          receivedAt,
        },
      });
    });

    try {
      const ours = this.applyMapping(payload, options);
      const mapped = await this.inTenant(caller.organizationId, async () =>
        this.mapPayload(ours),
      );
      const capture = await this.inTenant(caller.organizationId, async () =>
        this.leads.create(mapped.input as never),
      );

      const attached =
        'attachedToExisting' in capture &&
        (capture as { attachedToExisting?: boolean }).attachedToExisting === true;
      const result: IngestResult = {
        status: attached ? 'duplicate_attached' : 'created',
        leadId: capture.id,
        duplicateOf: attached ? capture.id : null,
        assignedTo:
          capture.assignment?.assignedUserId !== null &&
          capture.assignment?.assignedUserId !== undefined
            ? { id: capture.assignment.assignedUserId, name: null }
            : null,
        unmappedFields: mapped.unmapped,
        payloadId,
      };

      await this.settle(caller.organizationId, payloadId, {
        status: attached ? 'duplicate' : 'processed',
        leadId: capture.id,
      });
      await this.remember(caller.organizationId, endpoint, key, requestHash, result);
      this.logger.info(
        { payloadId, leadId: capture.id, attached, unmapped: mapped.unmapped },
        'public lead API capture',
      );
      return result;
    } catch (error) {
      const refused = error instanceof AppError && error.status < 500;
      const stage: IngestionStage = refused ? this.stageFor(error as AppError) : 'persist';
      await this.recordFailure(caller.organizationId, payloadId, receivedAt, {
        stage,
        error,
        // A refusal nothing can fix by re-running it is not replayable: a malformed body stays
        // malformed, and a duplicate rule set to reject will refuse it again.
        isReplayable: !refused,
      });
      if (refused) throw error;
      this.logger.error(
        { err: error, payloadId },
        'public lead API capture failed after the payload was stored',
      );
      throw new AppError(
        'INTERNAL_ERROR',
        'We stored your payload but could not process it yet. It will be retried; nothing was lost.',
        500,
      );
    }
  }

  /**
   * The dry run (`FR-CAP-6`'s "self-serve test tool").
   *
   * The same mapping the real capture does, answering what each step decided — and persisting
   * nothing. It is the honest answer to "why did my lead not appear", and it is a **read**: the
   * import's wizard paid for the lesson that a screen must never run a mutation to show a preview.
   */
  async dryRun(payload: PublicLeadInput) {
    const organizationId = tenantContext.organizationId('ingestion.dryRun');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { defaultPhoneCountry: true },
    });
    const mapped = await this.mapPayload(payload);
    const input = mapped.input as Record<string, unknown>;
    const notes = [...mapped.notes];

    /**
     * The **normalize** step, run for real — with the workspace's own country.
     *
     * A dry run that echoed the phone number as sent would be the import's lie in a new place: a
     * column of `not-a-phone` reported "5 rows ready to import" because the preview re-checked a
     * schema instead of doing what the write path does. The phone is the commonest reason a capture
     * is refused, so this is the one step the tool must actually perform. `normalizeContactNumbers`
     * is the same function `LeadsService` uses; `buildDisplayName` is the same rule it refuses on.
     */
    let phoneE164: string | null = null;
    let whatsappE164: string | null = null;
    let wouldCreate = true;
    try {
      const contact = normalizeContactNumbers(
        {
          phone: (input['phone'] as string | undefined) ?? null,
          whatsapp: (input['whatsapp'] as string | undefined) ?? null,
        },
        organization.defaultPhoneCountry as CountryCode,
      );
      phoneE164 = contact.phoneE164;
      whatsappE164 = contact.whatsappE164;
    } catch (error) {
      wouldCreate = false;
      notes.push(
        `${this.reasonFor(error)} The number is read as a ${organization.defaultPhoneCountry} number unless it starts with a country code.`,
      );
    }

    const fullName = buildDisplayName({
      firstName: input['firstName'] as string | undefined,
      lastName: input['lastName'] as string | undefined,
      company: input['company'] as string | undefined,
      email: input['email'] as string | undefined,
      phoneE164,
      whatsappE164,
    });
    if (fullName === '') {
      wouldCreate = false;
      notes.push('Give at least a name, a company, a phone number or an email address.');
    }

    return {
      // Answered honestly rather than hardcoded: a tool that says "yes" to a payload the real
      // endpoint would refuse is worse than no tool.
      wouldCreate,
      organizationId,
      normalized: {
        fullName: fullName === '' ? null : fullName,
        firstName: input['firstName'] ?? null,
        lastName: input['lastName'] ?? null,
        // As it would be stored, with what was sent beside it: the difference is the answer to
        // "why is this number not the one I typed".
        phone: phoneE164,
        phoneAsSent: input['phone'] ?? null,
        whatsapp: whatsappE164,
        email: input['email'] ?? null,
        city: input['city'] ?? null,
        valueMinor: input['valueMinor'] ?? null,
        leadSourceId: input['leadSourceId'] ?? null,
        consent: input['consent'] ?? {},
        utm: input['utm'] ?? {},
        customValues: input['customValues'] ?? {},
      },
      unmappedFields: mapped.unmapped,
      /** Named so a tenant can see what their payload failed to match before they send it live. */
      notes,
    };
  }

  // ── Reading, for the operator ─────────────────────────────────────────────

  async payloads(query: {
    status?: string;
    channel?: string;
    apiKeyId?: string;
    limit: number;
    cursor?: string;
  }) {
    const where: Record<string, unknown> = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.apiKeyId ? { apiKeyId: query.apiKeyId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.db.client.inboundPayload.count({ where }),
      this.db.client.inboundPayload.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { skip: 1 } : {}),
        include: {
          apiKey: { select: { id: true, name: true, keyPrefix: true } },
          errors: { orderBy: { createdAt: 'desc' }, take: 3 },
        },
      }),
    ]);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        channel: row.channel,
        status: row.status,
        apiKey: row.apiKey,
        leadId: row.leadId,
        error: row.error,
        attempts: row.attempts,
        replayedAt: row.replayedAt,
        idempotencyKey: row.idempotencyKey,
        receivedAt: row.receivedAt,
        body: row.rawBody,
        unmappedFields: unmappedKeys((row.rawBody ?? {}) as Record<string, unknown>),
        errors: row.errors.map((entry) => ({
          stage: entry.stage,
          code: entry.errorCode,
          message: entry.message,
          isReplayable: entry.isReplayable,
          createdAt: entry.createdAt,
        })),
      })),
      pagination: {
        limit: query.limit,
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > query.limit,
        total,
      },
    };
  }

  async errors(query: { stage?: string; replayable?: boolean; limit: number; cursor?: string }) {
    const where: Record<string, unknown> = {
      ...(query.stage ? { stage: query.stage } : {}),
      ...(query.replayable === undefined
        ? {}
        : query.replayable
          ? { isReplayable: true, replayedAt: null }
          : { isReplayable: false }),
    };
    const [total, rows] = await Promise.all([
      this.db.client.ingestionError.count({ where }),
      this.db.client.ingestionError.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    ]);
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        payloadId: row.payloadId,
        stage: row.stage,
        code: row.errorCode,
        message: row.message,
        details: row.details,
        isReplayable: row.isReplayable,
        replayedAt: row.replayedAt,
        createdAt: row.createdAt,
      })),
      pagination: {
        limit: query.limit,
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > query.limit,
        total,
      },
    };
  }

  /**
   * The unmapped fields a workspace has actually been sent (`FR-CAP-5`).
   *
   * Counted over the stored payloads rather than remembered in a column: the payloads are the
   * record, and a counter maintained beside them is a second definition of the same fact that can
   * drift. Each one carries a sample value, because "propertyType" alone does not tell somebody
   * whether it wants a text field or a dropdown.
   */
  async unmapped(limit = 200) {
    const rows = await this.db.client.inboundPayload.findMany({
      orderBy: { receivedAt: 'desc' },
      take: limit,
      select: { rawBody: true },
    });
    const seen = new Map<string, { count: number; samples: string[] }>();
    for (const row of rows) {
      const body = (row.rawBody ?? {}) as Record<string, unknown>;
      for (const key of unmappedKeys(body)) {
        const entry = seen.get(key) ?? { count: 0, samples: [] };
        entry.count += 1;
        const sample = body[key];
        const text = typeof sample === 'object' ? JSON.stringify(sample) : String(sample ?? '');
        if (entry.samples.length < 3 && text !== '' && !entry.samples.includes(text)) {
          entry.samples.push(text.slice(0, 80));
        }
        seen.set(key, entry);
      }
    }
    const items = [...seen.entries()]
      .map(([field, entry]) => ({ field, count: entry.count, samples: entry.samples }))
      // Count first, then the field's own name: two fields seen once each would otherwise appear
      // in whatever order the payloads happened to be read in, and a list that reorders itself
      // between refreshes is one nobody trusts.
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
    return {
      items,
      // `pagination` even though this list is not paginated: the envelope lifts `items` into
      // `data` **only** when it is present, so a list without it is answered as
      // `data: { items: [...] }` — green to a test that checks the status code and broken to every
      // client. The trap the industry-template catalogue paid for.
      pagination: { limit: items.length, nextCursor: null, hasMore: false, total: items.length },
      // What the count is over, said rather than implied: "3" means nothing without it.
      meta: { payloadsScanned: rows.length },
    };
  }

  /**
   * Replays a stored payload (`FR-CAP-6`).
   *
   * Through the same `capture` path as a live request, minus the authentication — the payload is
   * already attributed, and re-checking a signature against bytes we re-serialised would fail for
   * reasons that have nothing to do with the lead. The attempt count and `replayed_at` are written
   * so a second try is visible rather than inferred from two errors.
   */
  async replay(id: string) {
    const principal = tenantContext.require('ingestion.replay');
    const row = await this.db.client.inboundPayload.findFirst({ where: { id } });
    if (!row) throw AppError.notFound('Payload');
    if (row.status === 'processed' || row.status === 'duplicate') {
      throw AppError.businessRule(
        `That payload already became ${row.status === 'duplicate' ? 'a touch on an existing lead' : 'a lead'}. Replaying it would create a second one.`,
      );
    }

    const payload = (row.rawBody ?? {}) as PublicLeadInput;
    try {
      const mapped = await this.mapPayload(payload);
      const capture = await this.leads.create(mapped.input as never);
      const attached =
        'attachedToExisting' in capture &&
        (capture as { attachedToExisting?: boolean }).attachedToExisting === true;
      await this.db.client.inboundPayload.updateMany({
        where: { id: row.id },
        data: {
          status: attached ? 'duplicate' : 'processed',
          leadId: capture.id,
          error: null,
          attempts: { increment: 1 },
          replayedAt: new Date(),
          replayedById: principal.actorId ?? null,
        },
      });
      await this.db.client.ingestionError.updateMany({
        where: { payloadId: row.id, replayedAt: null },
        data: { replayedAt: new Date() },
      });
      return { id: row.id, status: attached ? 'duplicate' : 'processed', leadId: capture.id };
    } catch (error) {
      await this.recordFailure(row.organizationId, row.id, row.receivedAt, {
        stage: error instanceof AppError && error.status < 500 ? this.stageFor(error) : 'persist',
        error,
        isReplayable: !(error instanceof AppError && error.status < 500),
      });
      await this.db.client.inboundPayload.updateMany({
        where: { id: row.id },
        data: { attempts: { increment: 1 }, replayedAt: new Date() },
      });
      throw error;
    }
  }

  /**
   * Somebody else's field names as ours, checked against the schema the public endpoint publishes.
   *
   * Three things happen here that would each be a bug somewhere else:
   *
   *  * **The keys no mapping entry named are kept**, under the mapped values. `FR-CAP-5`'s
   *    one-click custom field is driven by the unmapped keys of a stored payload, so a mapping that
   *    dropped them would make that feature unreachable for every mapped provider — and the mapper
   *    below absorbs a key that has since become a field, which is the other half of the same
   *    feature.
   *  * **The connection's own defaults go underneath both.** A connection named "Partner site"
   *    supplies that source for a payload that does not name one; a payload that does name one
   *    wins, because the sender knows more about one lead than the connection does about all of
   *    them.
   *  * **The result is parsed by `publicLeadSchema`**, the same schema the public endpoint's pipe
   *    applies. A mapping that writes a 300-character city, or a `valueMinor` of "lots", is a
   *    refusal at the validate stage with the field named — not a Prisma error about a column
   *    width, and not a lead silently stored with a field missing.
   */
  private applyMapping(
    payload: Record<string, unknown>,
    options: CaptureOptions,
  ): PublicLeadInput {
    if (!options.mapping || options.mapping.length === 0) {
      return { ...(options.defaults ?? {}), ...payload } as PublicLeadInput;
    }
    const result = applyFieldMapping(payload, options.mapping);
    const kept: Record<string, unknown> = { ...(options.defaults ?? {}) };
    for (const key of result.unmapped) kept[key] = payload[key];
    const candidate = { ...kept, ...result.mapped };

    const parsed = publicLeadSchema.safeParse(candidate);
    if (!parsed.success) {
      throw AppError.validation('The mapped payload is not something we can accept', [
        ...parsed.error.issues.slice(0, 10).map((issue) => ({
          field: issue.path.join('.') || 'payload',
          code: 'INVALID_MAPPED_VALUE',
          message: issue.message,
        })),
      ]);
    }
    return parsed.data;
  }

  // ── The mapper ────────────────────────────────────────────────────────────

  /**
   * A payload as the shared capture path's input.
   *
   * This is where the **meaning** is checked, not in the schema: a source is resolved by name
   * against the tenant's own list, a custom field by key against the tenant's own definitions, and
   * anything that matches nothing becomes a note rather than a refusal. The import's dry run paid
   * for this exact lesson — a check that needs information a schema does not have belongs where
   * that information is.
   */
  private async mapPayload(payload: PublicLeadInput): Promise<{
    input: Record<string, unknown>;
    unmapped: string[];
    notes: string[];
  }> {
    const body = payload as Record<string, unknown>;
    const notes: string[] = [];
    const input: Record<string, unknown> = {};

    const name = typeof body['name'] === 'string' ? body['name'] : null;
    if (typeof body['firstName'] === 'string') input['firstName'] = body['firstName'];
    if (typeof body['lastName'] === 'string') input['lastName'] = body['lastName'];
    if (name && input['firstName'] === undefined) {
      // The same splitter the import and the forms use: the surname is the last word.
      const split = splitFullName(name);
      input['firstName'] = split.firstName;
      if (split.lastName && input['lastName'] === undefined) input['lastName'] = split.lastName;
    }

    for (const field of [
      'company',
      'jobTitle',
      'phone',
      'whatsapp',
      'email',
      'city',
      'state',
      'country',
      'postalCode',
    ] as const) {
      if (typeof body[field] === 'string' && body[field] !== '') input[field] = body[field];
    }
    if (typeof body['valueMinor'] === 'number') input['valueMinor'] = body['valueMinor'];
    if (typeof body['pageUrl'] === 'string') input['landingPageUrl'] = body['pageUrl'];
    if (typeof body['sessionId'] === 'string') input['sessionId'] = body['sessionId'];
    if (typeof body['visitorId'] === 'string') input['visitorId'] = body['visitorId'];
    input['utm'] = normalizeUtm(body['utm']);
    input['createdVia'] = 'api';

    const consent = body['consent'] as Record<string, unknown> | undefined;
    if (consent && typeof consent === 'object') {
      input['consent'] = {
        ...(consent['whatsapp'] === true ? { whatsapp: true } : {}),
        ...(consent['email'] === true ? { email: true } : {}),
        ...(consent['calls'] === true ? { calls: true } : {}),
      };
    }

    // The source, by name. An integrator has a name, not a uuid — and a name that matches nothing
    // is a note rather than a refusal, because losing the lead over an attribution is the worse
    // outcome by a long way.
    if (typeof body['source'] === 'string' && body['source'] !== '') {
      const source = await this.db.client.leadSource.findFirst({
        where: { name: { equals: body['source'], mode: 'insensitive' } },
        select: { id: true },
      });
      if (source) input['leadSourceId'] = source.id;
      else
        notes.push(`No lead source is called “${body['source']}”, so the capture is unattributed.`);
    }

    // The form, by slug, for a page that posts here instead of using the form endpoint.
    if (typeof body['formSlug'] === 'string' && body['formSlug'] !== '') {
      const form = await this.db.client.form.findFirst({
        where: { slug: body['formSlug'], deletedAt: null },
        select: { id: true, name: true },
      });
      if (form) {
        input['formId'] = form.id;
        input['formName'] = form.name;
      } else {
        notes.push(`No form has the address “${body['formSlug']}”.`);
      }
    }

    // Custom fields, by key, against this workspace's own definitions.
    const custom = body['customFields'];
    if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
      const definitions = await this.fields.definitionsFor('lead');
      const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
        if (byKey.has(key)) values[key] = value;
        else
          notes.push(
            `No custom field has the key “${key}”, so that answer was kept but not stored on the lead.`,
          );
      }
      if (Object.keys(values).length > 0) input['customValues'] = values;
    }

    // What they said, onto the timeline: a lead has no message column, and the sentence is the
    // reason for the call. `captureEntry` in `LeadsService` is keyed on the **answers**, not on a
    // form, precisely so this channel's message is not dropped — and the entry it writes is
    // `lead.enquiry_received` rather than a form submission that never happened.
    if (typeof body['message'] === 'string' && body['message'] !== '') {
      input['formAnswers'] = [{ label: 'Message', value: body['message'].slice(0, 2000) }];
    }

    const unmapped = await this.absorbKnownExtras(body, input, notes);
    return { input, unmapped, notes };
  }

  /**
   * The other half of the one click (`FR-CAP-5`).
   *
   * An integration sends `propertyType` at the top level, somebody turns it into a custom field
   * from the integration log, and from then on the same payload fills that field in. Without this,
   * the button creates a field nothing ever writes to — a feature that looks built, which is the
   * shape of bug this codebase keeps paying for.
   *
   * Two rules make it safe to do at capture time:
   *
   *  * The key is matched through `customFieldKeyFor`, the **same derivation** the button fills its
   *    key box with. One definition, or the field somebody made would not be the field we look for.
   *  * The value is validated against the definition **before** it is accepted, and a value that
   *    does not fit stays an unmapped field with a note. Otherwise making a `number` field out of
   *    `propertyType` would turn every capture that worked yesterday into a 400 — losing the lead
   *    over an attribution, which is the trade this whole endpoint refuses to make.
   */
  private async absorbKnownExtras(
    body: Readonly<Record<string, unknown>>,
    input: Record<string, unknown>,
    notes: string[],
  ): Promise<string[]> {
    const extras = unmappedKeys(body);
    if (extras.length === 0) return extras;

    const definitions = await this.fields.definitionsFor('lead');
    const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
    const candidates = extras
      .map((key) => ({ key, definition: byKey.get(customFieldKeyFor(key) ?? '') }))
      .filter((entry) => entry.definition !== undefined);
    if (candidates.length === 0) return extras;

    const organizationId = tenantContext.organizationId('ingestion.absorbKnownExtras');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { defaultPhoneCountry: true, defaultCurrency: true },
    });

    const absorbed: Record<string, unknown> = {};
    const stillUnmapped = new Set(extras);
    for (const { key, definition } of candidates) {
      if (definition === undefined) continue;
      try {
        const checked = validateCustomValues(
          [definition],
          { [definition.key]: body[key] },
          {
            // `patch`, not `create`: this list is one definition, and `create` would demand every
            // *other* required field of it.
            mode: 'patch',
            defaultPhoneCountry: organization.defaultPhoneCountry as CountryCode,
            defaultCurrency: organization.defaultCurrency,
          },
        );
        Object.assign(absorbed, checked.values);
        stillUnmapped.delete(key);
        notes.push(`“${key}” was stored on your field “${definition.label}”.`);
      } catch (error) {
        notes.push(
          `“${key}” matches your field “${definition.label}”, but the value was not accepted (${this.reasonFor(error)}), so it was kept in the payload only.`,
        );
      }
    }

    if (Object.keys(absorbed).length > 0) {
      input['customValues'] = {
        ...((input['customValues'] ?? {}) as Record<string, unknown>),
        ...absorbed,
      };
    }
    return extras.filter((key) => stillUnmapped.has(key));
  }

  /** The first field message of a refusal, which is the sentence a person can act on. */
  private reasonFor(error: unknown): string {
    if (error instanceof AppError) {
      const details = error.details as { message?: unknown }[] | undefined;
      const first = Array.isArray(details) ? details[0]?.message : undefined;
      return typeof first === 'string' ? first : error.message;
    }
    return 'it could not be read';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private inTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      systemPrincipal(organizationId, requestStore.requestId() ?? newId()),
      fn,
    );
  }

  /**
   * The outcome, written onto the stored payload.
   *
   * `updateMany` keyed on the **id alone**, not `update` on the `(id, received_at)` primary key.
   * The partition key is a `timestamptz(6)` and a JavaScript `Date` is milliseconds, so a row whose
   * `received_at` carries microseconds — anything written by raw SQL rather than by this service —
   * cannot be addressed by that key at all, and the update fails with "no record was found". The id
   * is unique per workspace (`inbound_payload_tenant_key`), so this is the same row either way, and
   * it cannot be defeated by a precision the application cannot express. Postgres refuses to alter
   * the type of a column named in a partition key, so the column is not the thing to change.
   */
  private async settle(
    organizationId: string,
    payloadId: string,
    outcome: { status: 'processed' | 'duplicate' | 'failed'; leadId?: string; error?: string },
  ): Promise<void> {
    await this.inTenant(organizationId, async () => {
      await this.db.client.inboundPayload.updateMany({
        where: { id: payloadId },
        data: {
          status: outcome.status,
          ...(outcome.leadId ? { leadId: outcome.leadId } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      });
    });
  }

  private async recordFailure(
    organizationId: string,
    payloadId: string,
    receivedAt: Date,
    failure: { stage: IngestionStage; error: unknown; isReplayable: boolean },
  ): Promise<void> {
    const message =
      failure.error instanceof Error ? failure.error.message.slice(0, 2000) : 'Unknown error';
    const code = failure.error instanceof AppError ? failure.error.code : 'INTERNAL_ERROR';
    const details =
      failure.error instanceof AppError && failure.error.details !== undefined
        ? { details: failure.error.details }
        : {};
    // A recorder of failures may not fail the request.
    //
    // It did: this write threw, the throw replaced the 400 that said what was actually wrong with a
    // 404 about the payload, and the screen told somebody their stored payload did not exist. What
    // a caller needs from this method is the original error, so the explanation is best-effort and
    // its own failure is logged rather than raised.
    try {
      await this.inTenant(organizationId, async () => {
        await this.db.client.$transaction(async (tx) => {
          await tx.inboundPayload.updateMany({
            where: { id: payloadId },
            data: { status: 'failed', error: message },
          });
          await tx.ingestionError.create({
            data: {
              id: newId(),
              organizationId,
              payloadId,
              // The composite FK spans `(organization_id, payload_id, payload_received_at)`, so
              // this has to be the parent's own instant — which is why the parent is only ever
              // written with a millisecond `Date` by this service.
              payloadReceivedAt: receivedAt,
              stage: failure.stage,
              errorCode: code,
              message,
              details: details as never,
              isReplayable: failure.isReplayable,
            },
          });
        });
      });
    } catch (error) {
      this.logger.error(
        { err: error, payloadId, stage: failure.stage },
        'could not record why a payload failed; the original failure stands',
      );
    }
  }

  /** Which step of the pipeline a refusal belongs to, for the error log's `stage`. */
  private stageFor(error: AppError): IngestionStage {
    if (error.code === 'VALIDATION_FAILED' || error.code === 'INVALID_PHONE') return 'validate';
    if (error.code === 'CONFLICT' || error.code === 'DUPLICATE_LEAD') return 'duplicate_check';
    if (error.code === 'LIMIT_EXCEEDED' || error.code === 'FEATURE_NOT_IN_PLAN') return 'persist';
    return 'normalize';
  }

  private async remember(
    organizationId: string,
    endpoint: string,
    key: string,
    requestHash: string,
    result: IngestResult,
  ): Promise<void> {
    await this.inTenant(organizationId, async () => {
      await this.db.client.idempotencyKey.create({
        data: {
          id: newId(),
          organizationId,
          key,
          endpoint,
          requestHash,
          responseStatus: result.status === 'created' ? 201 : 200,
          responseBody: result as never,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3_600_000),
        },
      });
    });
  }

  /** A keyed hash of the address, never the address — as the form endpoint stores it. */
  private hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return createHmac('sha256', this.config.ENCRYPTION_MASTER_KEY)
      .update(ip)
      .digest('base64url')
      .slice(0, 32);
  }

  /** Platform-wide read for the maintenance sweep that prunes expired idempotency keys. */
  async pruneIdempotencyKeys(now = new Date()): Promise<number> {
    return withPlatformScope('maintenance: prune expired idempotency keys', async () => {
      const result = await this.db.client.idempotencyKey.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      return result.count;
    });
  }
}
