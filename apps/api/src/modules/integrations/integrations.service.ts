import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  applyFieldMapping,
  describeStatus,
  findProvider,
  mappingProblems,
  newId,
  systemPrincipal,
  tenantContext,
  withPlatformScope,
  type FieldMapping,
  type IntegrationProvider,
  type IntegrationStatus,
} from '@leados/shared';
import type { Logger } from 'pino';
import { AuditService } from '../../infra/audit/audit.service.js';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { IntegrationHealthService } from './integration-health.service.js';
import { IntegrationRegistryService } from './integration-registry.service.js';
import { IntegrationVaultService } from './integration-vault.service.js';
import { sharedSecretField } from './adapters/secret-names.js';
import type {
  ConnectIntegrationInput,
  ListHealthChecksQuery,
  ListProviderEventsQuery,
  ListIntegrationsQuery,
  PreviewMappingInput,
  UpdateIntegrationInput,
} from './integrations.dto.js';

/** What the inbound door needs about a connection, with its secrets opened and nothing else. */
export interface InboundConnection {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly secrets: Readonly<Record<string, string>>;
  readonly settings: Record<string, unknown>;
  readonly mapping: readonly FieldMapping[];
  readonly sourceName: string | null;
  readonly externalAccountId: string | null;
}

/**
 * The columns every presenter reads. Note what is **absent**: `credentials_encrypted`.
 *
 * A `select` rather than a trusting `findFirst`, so the credential cannot reach a response by
 * somebody adding a field to the presenter later. The vault's rule — plaintext never leaves — is
 * only worth as much as the query that cannot carry the ciphertext either.
 */
const PUBLIC_COLUMNS = {
  id: true,
  provider: true,
  name: true,
  externalAccountId: true,
  keyVersion: true,
  scopes: true,
  settings: true,
  fieldMappings: true,
  status: true,
  lastSuccessAt: true,
  lastErrorAt: true,
  lastError: true,
  expiresAt: true,
  connectedById: true,
  createdAt: true,
  updatedAt: true,
  disconnectedAt: true,
} as const;

/**
 * Connected providers (Phase 4's "provider registry, credential vault, health checks, generic
 * mapping templates").
 *
 * Four decisions worth stating, each with a plausible wrong answer:
 *
 *  * **A disconnect is soft, and a reconnect is a new row.** `inbound_payloads` references the
 *    connection that brought each lead in, so deleting one would either orphan that history or
 *    refuse the delete and make a mistaken connection permanent. The partial unique index
 *    (`integration_connections_live_provider`) is what makes this work: one *live* connection per
 *    provider, and as many disconnected ones as a workspace has had.
 *  * **The secret is answered exactly once**, by `connect` and `rotateSecret`, for a
 *    `shared_secret` provider. An `api_key` provider's token is never answered at all — it was
 *    the caller's to begin with, and echoing it back would put somebody else's credential in our
 *    response log for no gain.
 *  * **A mapping is validated by `mappingProblems`, all of it at once.** A mapping with four
 *    mistakes corrected one refusal at a time is four round trips, and the problem a schema cannot
 *    see — two sources writing one target, so the lower one wins silently — is the one that costs
 *    an afternoon.
 *  * **Connecting probes immediately.** A connection that says `connected` because nothing has
 *    asked is the same lie as a dry run that echoes its input: the first thing somebody wants to
 *    know is whether the token they pasted works, and the answer is one request away.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly registry: IntegrationRegistryService,
    private readonly vault: IntegrationVaultService,
    private readonly health: IntegrationHealthService,
    private readonly ingestion: IngestionService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  // ── The catalogue ─────────────────────────────────────────────────────────

  /**
   * What can be connected, and what already is.
   *
   * The two in one answer rather than two endpoints, because the screen's question is "what are my
   * options" and a provider's own row is part of its option: the connect button on a provider that
   * is already live has to say "manage" instead.
   */
  async catalogue() {
    const live = await this.db.client.integrationConnection.findMany({
      where: { disconnectedAt: null },
      select: { id: true, provider: true, name: true, status: true, lastSuccessAt: true },
    });
    const byProvider = new Map(live.map((row) => [row.provider, row]));
    const items = this.registry.providers().map((provider) => ({
      ...describeProvider(provider),
      connection: byProvider.get(provider.key)
        ? {
            id: byProvider.get(provider.key)!.id,
            name: byProvider.get(provider.key)!.name,
            status: byProvider.get(provider.key)!.status,
            summary: describeStatus(
              byProvider.get(provider.key)!.status as IntegrationStatus,
              byProvider.get(provider.key)!.lastSuccessAt?.toISOString() ?? null,
            ),
          }
        : null,
      /** Whether "test this connection" does anything for this provider. */
      probeable: this.registry.canProbe(provider.key),
    }));
    return {
      items,
      pagination: { limit: items.length, nextCursor: null, hasMore: false, total: items.length },
      meta: { connected: live.length },
    };
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(query: ListIntegrationsQuery) {
    const where = {
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.status ? { status: query.status } : {}),
      // Absent means the live ones, which is what a screen about "my integrations" is about.
      disconnectedAt: query.disconnected === true ? { not: null } : null,
    };
    const [total, rows] = await Promise.all([
      this.db.client.integrationConnection.count({ where }),
      this.db.client.integrationConnection.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: query.limit,
        select: {
          ...PUBLIC_COLUMNS,
          healthChecks: {
            orderBy: { checkedAt: 'desc' },
            take: 1,
            select: { outcome: true, latencyMs: true, checkedAt: true, detail: true },
          },
        },
      }),
    ]);
    return {
      items: rows.map((row) => this.present(row)),
      pagination: { limit: query.limit, nextCursor: null, hasMore: false, total },
    };
  }

  async findOne(id: string) {
    const row = await this.db.client.integrationConnection.findFirst({
      where: { id },
      select: {
        ...PUBLIC_COLUMNS,
        healthChecks: {
          orderBy: { checkedAt: 'desc' },
          take: 10,
          select: { outcome: true, latencyMs: true, checkedAt: true, detail: true },
        },
      },
    });
    if (!row) throw AppError.notFound('Connection');
    return this.present(row);
  }

  /**
   * The health history (Phase 4's "per-connection health checks").
   *
   * A list of probes rather than a column, because "it has been failing since Tuesday" is the
   * question an operator actually asks and a single `last_checked_at` cannot answer it.
   */
  async healthChecks(query: ListHealthChecksQuery) {
    const where = {
      ...(query.connectionId ? { connectionId: query.connectionId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
    };
    const [total, rows] = await Promise.all([
      this.db.client.integrationHealthCheck.count({ where }),
      this.db.client.integrationHealthCheck.findMany({
        where,
        orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        include: { connection: { select: { id: true, provider: true, name: true, status: true } } },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        connection: row.connection,
        outcome: row.outcome,
        latencyMs: row.latencyMs,
        detail: row.detail,
        checkedAt: row.checkedAt,
      })),
      pagination: { limit: query.limit, nextCursor: null, hasMore: false, total },
    };
  }

  /**
   * What each provider has told us, and what became of it (the ledger, read).
   *
   * The question this answers is the one somebody asks when a lead did not appear: Meta said
   * something, and either it became a lead or it did not and here is the provider's own reason. The
   * `raw` delivery is included, because "what did they actually send" is the next question and the
   * payload store cannot answer it for an event that never got as far as a capture.
   */
  async providerEvents(query: ListProviderEventsQuery) {
    const where = {
      ...(query.connectionId ? { connectionId: query.connectionId } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, unresolved, rows] = await Promise.all([
      this.db.client.providerEvent.count({ where }),
      // The figure beside the list is over the **whole** set, not this page: a board that totals
      // its page tells somebody their problem is a fifth of its real size.
      this.db.client.providerEvent.count({ where: { status: 'failed' } }),
      this.db.client.providerEvent.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        include: { connection: { select: { id: true, provider: true, name: true } } },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        providerLabel: findProvider(row.provider)?.label ?? row.provider,
        connection: row.connection,
        externalEventId: row.externalEventId,
        eventType: row.eventType,
        status: row.status,
        leadId: row.leadId,
        error: row.error,
        attempts: row.attempts,
        receivedAt: row.receivedAt,
        processedAt: row.processedAt,
        raw: row.raw,
      })),
      pagination: { limit: query.limit, nextCursor: null, hasMore: false, total },
      meta: { unresolved },
    };
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  async connect(input: ConnectIntegrationInput) {
    const principal = tenantContext.require('integrations.connect');
    const { provider, adapter } = this.registry.require(input.provider);

    const existing = await this.db.client.integrationConnection.findFirst({
      where: { provider: provider.key, disconnectedAt: null },
      select: { id: true, name: true },
    });
    if (existing) {
      // Named, with its id, so the screen can offer the one thing somebody wants next.
      throw AppError.businessRule(
        `${provider.label} is already connected as “${existing.name}”. Disconnect that one first, or edit it.`,
      );
    }

    this.assertSettings(provider, input.settings);
    const mapping = this.checkMapping(provider, input.fieldMappings ?? provider.defaultMapping);

    // The id first, because the credential's ciphertext is bound to it: an AAD computed from
    // anything else — or a row created and then updated — is a secret that is not tied to its row.
    const id = newId();
    const shared = provider.authKind === 'shared_secret';
    const supplied = input.credentials ?? {};
    if (!shared) this.assertCredentials(provider, supplied);
    await adapter.validate({ secrets: supplied, settings: input.settings });
    // For a `shared_secret` provider the whole credential is ours, filed under the one name its
    // adapter reads. Nothing is generated for an `api_key` provider: the secrets are the caller's.
    const secrets = shared ? { [sharedSecretField(provider.key)]: this.vault.generateSharedSecret() } : supplied;

    await this.db.client.$transaction(async (tx) => {
      await tx.integrationConnection.create({
        data: {
          id,
          organizationId: principal.organizationId,
          provider: provider.key,
          name: input.name,
          externalAccountId: input.externalAccountId ?? null,
          credentialsEncrypted: this.vault.seal(id, secrets),
          keyVersion: this.vault.keyVersion,
          scopes: [],
          settings: input.settings as never,
          fieldMappings: mapping as never,
          status: 'connected',
          connectedById: principal.actorId ?? null,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'integration.connected',
        resourceType: 'integration_connection',
        resourceId: id,
        // The provider and the settings, never the credential: an audit log is read by more people
        // than the vault is.
        after: { provider: provider.key, name: input.name, settings: input.settings },
      });
    });

    // Immediately, and before answering: "did the token I just pasted work" is the question, and
    // a row that says `connected` because nothing has asked is the dry run's lie in a new place.
    await this.probeQuietly(id, provider.key);

    const connection = await this.findOne(id);
    return {
      ...connection,
      // Answered exactly once, and only for a provider whose secret we minted. An `api_key`
      // provider's token was the caller's; echoing it back puts their credential in our logs.
      ...(shared
        ? { secret: secrets[sharedSecretField(provider.key)]!, secretShownOnce: true as const }
        : {}),
    };
  }

  async update(id: string, input: UpdateIntegrationInput) {
    const row = await this.db.client.integrationConnection.findFirst({
      where: { id },
      select: { id: true, provider: true, name: true, settings: true, disconnectedAt: true },
    });
    if (!row) throw AppError.notFound('Connection');
    if (row.disconnectedAt !== null) {
      throw AppError.businessRule(
        'That connection is disconnected. Connect the provider again rather than editing its history.',
      );
    }
    const { provider, adapter } = this.registry.require(row.provider);

    const settings =
      input.settings === undefined
        ? ((row.settings ?? {}) as Record<string, unknown>)
        : input.settings;
    if (input.settings !== undefined) this.assertSettings(provider, settings);
    const mapping =
      input.fieldMappings === undefined ? undefined : this.checkMapping(provider, input.fieldMappings);

    if (input.credentials !== undefined) {
      if (provider.authKind === 'shared_secret') {
        throw AppError.businessRule(
          'This connection’s secret is generated here. Use “rotate the secret” to replace it.',
        );
      }
      this.assertCredentials(provider, input.credentials);
      await adapter.validate({ secrets: input.credentials, settings });
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.integrationConnection.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.externalAccountId !== undefined
            ? { externalAccountId: input.externalAccountId }
            : {}),
          ...(input.settings !== undefined ? { settings: input.settings as never } : {}),
          ...(mapping !== undefined ? { fieldMappings: mapping as never } : {}),
          ...(input.credentials !== undefined
            ? {
                credentialsEncrypted: this.vault.seal(id, input.credentials),
                keyVersion: this.vault.keyVersion,
                // A new credential starts again from `connected`: leaving a `revoked` connection
                // revoked after somebody has pasted a fresh token is the product refusing to be
                // fixed, which is the lesson the webhook endpoint's failure count paid for.
                status: 'connected',
                lastError: null,
                lastErrorAt: null,
              }
            : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: input.credentials !== undefined ? 'integration.reconnected' : 'integration.updated',
        resourceType: 'integration_connection',
        resourceId: id,
        before: { name: row.name, settings: row.settings },
        after: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.settings !== undefined ? { settings: input.settings } : {}),
          ...(mapping !== undefined ? { fieldMappings: mapping } : {}),
          ...(input.credentials !== undefined ? { credentialsRotated: Object.keys(input.credentials) } : {}),
        },
      });
    });

    if (input.credentials !== undefined) await this.probeQuietly(id, provider.key);
    return this.findOne(id);
  }

  /** A new inbound secret for the same connection. The old one stops verifying immediately. */
  async rotateSecret(id: string) {
    const row = await this.db.client.integrationConnection.findFirst({
      where: { id },
      select: { id: true, provider: true, disconnectedAt: true },
    });
    if (!row) throw AppError.notFound('Connection');
    const { provider } = this.registry.require(row.provider);
    if (provider.authKind !== 'shared_secret') {
      throw AppError.businessRule(
        `${provider.label}’s credential comes from ${provider.label}. Paste a new token instead.`,
      );
    }
    if (row.disconnectedAt !== null) throw AppError.businessRule('That connection is disconnected.');

    const secret = this.vault.generateSharedSecret();
    await this.db.client.$transaction(async (tx) => {
      await tx.integrationConnection.update({
        where: { id },
        data: {
          credentialsEncrypted: this.vault.seal(id, {
            [sharedSecretField(provider.key)]: secret,
          }),
          keyVersion: this.vault.keyVersion,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'integration.secret_rotated',
        resourceType: 'integration_connection',
        resourceId: id,
      });
    });
    return { ...(await this.findOne(id)), secret, secretShownOnce: true as const };
  }

  /**
   * Switches it off and keeps its history.
   *
   * `status` moves off `connected` in the same statement as `disconnected_at`, because a CHECK
   * refuses a disconnected connection that still claims to be connected — and because a row saying
   * both would make every screen choose which half to believe.
   */
  async disconnect(id: string) {
    const row = await this.db.client.integrationConnection.findFirst({
      where: { id },
      select: { id: true, provider: true, name: true, disconnectedAt: true },
    });
    if (!row) throw AppError.notFound('Connection');
    if (row.disconnectedAt !== null) {
      // Idempotent rather than a refusal: two clicks on one button is not an error.
      return this.findOne(id);
    }

    const disconnectedAt = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.integrationConnection.update({
        where: { id },
        data: { disconnectedAt, status: 'revoked', lastErrorAt: disconnectedAt, lastError: 'Disconnected by the workspace' },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'integration.disconnected',
        resourceType: 'integration_connection',
        resourceId: id,
        before: { provider: row.provider, name: row.name },
      });
    });
    this.logger.info({ connectionId: id, provider: row.provider }, 'integration disconnected');
    return this.findOne(id);
  }

  // ── Checking ──────────────────────────────────────────────────────────────

  /** The button: probe this connection now, and say what came back. */
  async check(id: string) {
    const row = await this.db.client.integrationConnection.findFirst({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        provider: true,
        name: true,
        status: true,
        credentialsEncrypted: true,
        settings: true,
        externalAccountId: true,
        disconnectedAt: true,
      },
    });
    if (!row) throw AppError.notFound('Connection');
    if (row.disconnectedAt !== null) {
      throw AppError.businessRule('That connection is disconnected, so there is nothing to check.');
    }
    if (!this.registry.canProbe(row.provider)) {
      const { provider } = this.registry.require(row.provider);
      // The honest refusal, with what to do instead. A fake green tick would be worse.
      throw AppError.businessRule(
        `There is nothing to ask ${provider.label}: it sends to us, so this connection is healthy when something arrives. Use the mapping preview to check what a payload would become.`,
      );
    }
    return this.health.check({ ...row, status: row.status as IntegrationStatus });
  }

  /**
   * What a payload would become (`FR-CAP-6`'s test tool, for a mapped provider).
   *
   * It runs the mapping **and** the capture's own normalisation, through the same two functions the
   * write path uses, and persists nothing. A preview that echoed the mapping's output without
   * normalising would be the import's lie in a third place: the commonest reason a mapped capture
   * is refused is a phone number, and the mapping is not what refuses it.
   */
  async previewMapping(id: string, input: PreviewMappingInput) {
    const row = await this.db.client.integrationConnection.findFirst({
      where: { id },
      select: { id: true, provider: true, fieldMappings: true },
    });
    if (!row) throw AppError.notFound('Connection');
    const { provider } = this.registry.require(row.provider);
    if (!provider.mappable) {
      throw AppError.businessRule(
        `${provider.label} does not bring leads in, so it has no field mapping to preview.`,
      );
    }

    const mapping =
      input.fieldMappings !== undefined
        ? this.checkMapping(provider, input.fieldMappings)
        : storedMapping(row.fieldMappings);
    const result = applyFieldMapping(input.payload, mapping);
    // The same dry run the public lead API exposes, on the mapped payload: it answers whether the
    // lead would be created, with the phone as it would be stored beside the phone as sent.
    const dryRun = await this.ingestion.dryRun({
      ...passthrough(input.payload, result.unmapped),
      ...result.mapped,
    } as never);
    return {
      mapped: result.mapped,
      /** Sources the mapping named and this payload did not carry — the answer to a stale mapping. */
      missing: result.missing,
      unmapped: result.unmapped,
      ...dryRun,
    };
  }

  // ── The inbound door ──────────────────────────────────────────────────────

  /**
   * The connection a signed inbound request belongs to, with its secret opened.
   *
   * Platform-scoped by necessity — the URL is the only thing that says which workspace this is, as
   * the public lead API's path key is — and the lookup is by **id and provider together**: a
   * request posted to the right id under the wrong provider's path is somebody confused at best,
   * and the composite read means the path cannot be used to enumerate which provider a given id is.
   */
  async openForInbound(
    provider: string,
    connectionId: string,
  ): Promise<InboundConnection> {
    const { provider: registered } = this.registry.require(provider);
    if (registered.inboundVerification === 'none') {
      // A provider that does not post to us has no inbound door. Decided by **how it verifies**
      // rather than by its auth kind: Meta Lead Ads holds a token we send *and* posts to us, and an
      // earlier draft keyed this off `authKind === 'shared_secret'` and would have 404'd it.
      throw AppError.notFound('Connection');
    }
    // Across tenants, and audited by the reason string: the URL is the only thing that says which
    // workspace this is, exactly as the public lead API's path key is — and this route is
    // `@Public()`, so there is no context for a scoped read to filter by. Without this the
    // scoped client throws before any signature is checked, and every inbound request is a 500.
    const row = await withPlatformScope(
      'integration ingestion: resolve the connection from its inbound URL',
      async () =>
        this.db.client.integrationConnection.findFirst({
          where: { id: connectionId, provider: registered.key, disconnectedAt: null },
          select: {
            id: true,
            organizationId: true,
            credentialsEncrypted: true,
            fieldMappings: true,
            settings: true,
            externalAccountId: true,
          },
        }),
    );
    // A disconnected connection and one that never existed answer the same 404: the shape of an id
    // must not become an oracle, which is the rule `UuidParamPipe` exists for.
    if (!row) throw AppError.notFound('Connection');

    const settings = (row.settings ?? {}) as Record<string, unknown>;
    return {
      organizationId: row.organizationId,
      connectionId: row.id,
      provider: registered.key,
      secrets: this.vault.open(row.id, row.credentialsEncrypted, sharedSecretField(registered.key)),
      settings,
      mapping: storedMapping(row.fieldMappings),
      sourceName: typeof settings['sourceName'] === 'string' ? settings['sourceName'] : null,
      externalAccountId: row.externalAccountId,
    };
  }

  /**
   * The same credential, opened inside the workspace's own context — for an **outbound** call.
   *
   * Scoped, not platform-scoped: a send has a principal, so the tenant-scoping extension is both
   * correct and the stronger guarantee — a connection id from another workspace is simply not
   * found, with no reason string to get wrong. The two methods are deliberately separate rather
   * than one with a flag: "which scope does this read use" is exactly the question a flag hides.
   */
  async openForSending(provider: string, connectionId: string): Promise<InboundConnection> {
    const { provider: registered } = this.registry.require(provider);
    const row = await this.db.client.integrationConnection.findFirst({
      where: { id: connectionId, provider: registered.key, disconnectedAt: null },
      select: {
        id: true,
        organizationId: true,
        credentialsEncrypted: true,
        fieldMappings: true,
        settings: true,
        externalAccountId: true,
      },
    });
    if (!row) throw AppError.notFound('Connection');
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    return {
      organizationId: row.organizationId,
      connectionId: row.id,
      provider: registered.key,
      secrets: this.vault.open(row.id, row.credentialsEncrypted, sharedSecretField(registered.key)),
      settings,
      mapping: storedMapping(row.fieldMappings),
      sourceName: typeof settings['sourceName'] === 'string' ? settings['sourceName'] : null,
      externalAccountId: row.externalAccountId,
    };
  }

  /**
   * What a successful inbound capture writes back: the connection is demonstrably working.
   *
   * Inside the connection's own tenant context, not under `withPlatformScope`: this is a write to
   * a tenant table, and a platform-scoped write is the one thing that scope is not for. The
   * request itself is `@Public()`, so the context has to be entered here.
   */
  async recordInboundSuccess(organizationId: string, connectionId: string): Promise<void> {
    await tenantContext.run(systemPrincipal(organizationId, newId()), async () => {
      await this.db.client.integrationConnection.updateMany({
        where: { id: connectionId },
        data: { lastSuccessAt: new Date(), status: 'connected', lastError: null },
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Every problem at once, in the words of somebody editing the mapping. */
  private checkMapping(
    provider: IntegrationProvider,
    mapping: readonly FieldMapping[],
  ): readonly FieldMapping[] {
    if (!provider.mappable && mapping.length > 0) {
      throw AppError.validation('That provider does not map fields', [
        {
          field: 'fieldMappings',
          code: 'MAPPING_NOT_SUPPORTED',
          message: `${provider.label} does not bring leads in, so a field mapping would never be used.`,
        },
      ]);
    }
    const problems = mappingProblems(mapping);
    if (problems.length > 0) {
      throw AppError.validation('That field mapping cannot be used', [
        ...problems.map((problem) => ({
          field: `fieldMappings.${problem.index}`,
          code: 'INVALID_MAPPING',
          message: problem.message,
        })),
      ]);
    }
    return mapping;
  }

  /** The secrets the registry says are required, present — and nothing it has not declared. */
  private assertCredentials(
    provider: IntegrationProvider,
    supplied: Readonly<Record<string, string>>,
  ): void {
    const missing = provider.credentialFields
      .filter((field) => field.required)
      .filter((field) => (supplied[field.key] ?? '').trim() === '');
    if (missing.length > 0) {
      throw AppError.validation(`${provider.label} needs its credentials`, [
        ...missing.map((field) => ({
          field: `credentials.${field.key}`,
          code: 'CREDENTIAL_REQUIRED',
          message: field.hint ?? `${field.label} is required.`,
        })),
      ]);
    }
    const known = new Set(provider.credentialFields.map((field) => field.key));
    const unknown = Object.keys(supplied).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      // Refused rather than stored: a secret nothing reads is a secret somebody believes is
      // protecting something, which is worse than no secret at all.
      throw AppError.validation(`${provider.label} has no such credential`, [
        ...unknown.map((key) => ({
          field: `credentials.${key}`,
          code: 'UNKNOWN_CREDENTIAL',
          message: `${provider.label} takes: ${provider.credentialFields.map((field) => field.key).join(', ') || 'no credentials — we generate its secret'}.`,
        })),
      ]);
    }
  }

  /** The settings the registry says are required, present. Nothing about their meaning. */
  private assertSettings(provider: IntegrationProvider, settings: Record<string, unknown>): void {
    const missing = provider.settings
      .filter((setting) => setting.required)
      .filter((setting) => {
        const value = settings[setting.key];
        return value === undefined || value === null || value === '';
      });
    if (missing.length > 0) {
      throw AppError.validation(`${provider.label} needs a little more`, [
        ...missing.map((setting) => ({
          field: `settings.${setting.key}`,
          code: 'SETTING_REQUIRED',
          message: setting.hint ?? `${setting.label} is required.`,
        })),
      ]);
    }
    const known = new Set(provider.settings.map((setting) => setting.key));
    const unknown = Object.keys(settings).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      // Refused rather than stored: a setting nothing reads is a box somebody filled in believing
      // it did something, which is the same half-truth as a preference screen with dead switches.
      throw AppError.validation(`${provider.label} has no such setting`, [
        ...unknown.map((key) => ({
          field: `settings.${key}`,
          code: 'UNKNOWN_SETTING',
          message: `${provider.label} takes: ${provider.settings.map((setting) => setting.key).join(', ') || 'no settings'}.`,
        })),
      ]);
    }
  }

  /**
   * Probes without letting the probe decide whether the write succeeded.
   *
   * The connection is already stored; a provider that is down at this exact moment must not turn a
   * successful connect into a 500 the person reads as "it did not save". The outcome is on the row
   * and in the health history, which is where the screen reads it from anyway.
   */
  private async probeQuietly(id: string, provider: string): Promise<void> {
    // Asked rather than attempted-and-caught: a provider with no probe is the ordinary case for an
    // inbound connection, and a caught refusal would put a warning in the log every time somebody
    // connects one.
    if (!this.registry.canProbe(provider)) return;
    try {
      await this.check(id);
    } catch (error) {
      this.logger.warn({ err: error, connectionId: id }, 'the first probe of a new connection failed');
    }
  }

  private present(row: {
    id: string;
    provider: string;
    name: string;
    externalAccountId: string | null;
    keyVersion: number;
    scopes: string[];
    settings: unknown;
    fieldMappings: unknown;
    status: string;
    lastSuccessAt: Date | null;
    lastErrorAt: Date | null;
    lastError: string | null;
    expiresAt: Date | null;
    connectedById: string | null;
    createdAt: Date;
    updatedAt: Date;
    disconnectedAt: Date | null;
    healthChecks?: {
      outcome: string;
      latencyMs: number | null;
      checkedAt: Date;
      detail: unknown;
    }[];
  }) {
    const provider = findProvider(row.provider);
    return {
      id: row.id,
      provider: row.provider,
      providerLabel: provider?.label ?? row.provider,
      capabilities: provider?.capabilities ?? [],
      authKind: provider?.authKind ?? null,
      inboundVerification: provider?.inboundVerification ?? 'none',
      name: row.name,
      externalAccountId: row.externalAccountId,
      keyVersion: row.keyVersion,
      scopes: row.scopes,
      settings: row.settings,
      fieldMappings: row.fieldMappings,
      status: row.status,
      // The sentence, beside the status: a screen that renders `degraded` as the word "degraded"
      // is a screen written for the schema rather than for the person reading it.
      statusSummary: describeStatus(
        row.status as IntegrationStatus,
        row.lastSuccessAt?.toISOString() ?? null,
      ),
      lastSuccessAt: row.lastSuccessAt,
      lastErrorAt: row.lastErrorAt,
      lastError: row.lastError,
      expiresAt: row.expiresAt,
      connectedById: row.connectedById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      disconnectedAt: row.disconnectedAt,
      recentChecks: (row.healthChecks ?? []).map((check) => ({
        outcome: check.outcome,
        latencyMs: check.latencyMs,
        checkedAt: check.checkedAt,
        detail: check.detail,
      })),
    };
  }
}

/** The catalogue entry a screen renders, without the mapping machinery it does not need. */
function describeProvider(provider: IntegrationProvider) {
  return {
    key: provider.key,
    label: provider.label,
    summary: provider.summary,
    capabilities: provider.capabilities,
    authKind: provider.authKind,
    // The names, labels and hints only — never a value, because there is never a value to send.
    credentialFields: provider.credentialFields,
    settings: provider.settings,
    mappable: provider.mappable,
    defaultMapping: provider.defaultMapping,
    probeEveryMinutes: provider.probeEveryMinutes,
    // What the screen needs to decide whether this provider has an inbound address at all, and
    // which snippet to show beside it.
    inboundVerification: provider.inboundVerification,
    deliveryIsAReference: provider.deliveryIsAReference,
  };
}

/**
 * A stored mapping as the mapper's own type.
 *
 * One cast in one place, with a CHECK behind it: `integration_connections_mappings_are_a_list`
 * refuses anything that is not a JSON array, and every write goes through `mappingProblems` first.
 * The alternative — re-validating on every read — would make a row written by this service
 * untrustworthy to this service.
 */
function storedMapping(value: unknown): readonly FieldMapping[] {
  return Array.isArray(value) ? (value as unknown as FieldMapping[]) : [];
}

/** The keys no mapping entry named, kept so `FR-CAP-5`'s one-click field still has something to see. */
function passthrough(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of keys) kept[key] = payload[key];
  return kept;
}
