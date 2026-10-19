import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  findProvider,
  newId,
  systemPrincipal,
  tenantContext,
  withPlatformScope,
  type IngestChannel,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { IntegrationRegistryService } from './integration-registry.service.js';
import { IntegrationsService, type InboundConnection } from './integrations.service.js';
import type { ProviderDelivery } from './integration.port.js';

/** Which `inbound_payloads.channel` a provider's captures are filed under. */
const CHANNELS: Readonly<Record<string, IngestChannel>> = {
  generic_webhook: 'webhook',
  meta_lead_ads: 'meta_ads',
  google_ads_leads: 'google_ads',
};

/** What one delivery did, as the provider is told and as the log records. */
export interface DeliveryOutcome {
  /** Events the ledger had never seen, now queued. */
  readonly accepted: number;
  /** Events the ledger already had — a retry, which must produce no second lead. */
  readonly duplicates: number;
  /** Events the adapter recognised but which carry nothing to capture (a provider's test ping). */
  readonly ignored: number;
}

/**
 * A provider's delivery, turned into leads (Phase 4's fifth exit criterion).
 *
 * The shape §7 of `api-architecture.md` specifies, and the reason each step is in this order:
 *
 *  1. **Resolve the connection** from the path, across tenants, because the URL is the only thing
 *     that says which workspace a delivery belongs to.
 *  2. **Verify**, by whichever of the three schemes the provider declares. A failure is a 401 and
 *     nothing is written: a delivery we cannot attribute is not a delivery.
 *  3. **Insert `provider_events`**, keyed on the provider's **own** id for the event. That insert
 *     is the idempotency guarantee — a retried delivery fails the unique rather than producing a
 *     second lead — and it is why this step comes before any work.
 *  4. **Enqueue, and answer 200.** A provider that waits for us is a provider that retries; §7 asks
 *     for an acknowledgement in under a second. The ledger row is the durable record, so a worker
 *     restart costs a job and not a lead.
 *
 * A provider with **no event id of its own** (the generic webhook) does not use the ledger at all:
 * there is nothing to deduplicate on, and a key we invented would make every distinct lead look
 * like a replay. That door stays synchronous, answers the lead id, and deduplicates on
 * `Idempotency-Key` through `idempotency_keys` — which is what `FR-API-5` already specifies.
 */
@Injectable()
export class IntegrationInboundService {
  constructor(
    private readonly db: DbService,
    private readonly registry: IntegrationRegistryService,
    private readonly integrations: IntegrationsService,
    private readonly ingestion: IngestionService,
    private readonly queues: QueueService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The connection a delivery names, verified. Throws the 404s and the 401. */
  async authenticate(input: {
    provider: string;
    connectionId: string;
    rawBody: string;
    body: Record<string, unknown>;
    headers: Readonly<Record<string, string | undefined>>;
  }): Promise<InboundConnection> {
    const connection = await this.integrations.openForInbound(input.provider, input.connectionId);
    const { adapter } = this.registry.require(input.provider);
    if (adapter.verifyInbound === undefined) throw AppError.notFound('Connection');

    const check = adapter.verifyInbound({
      rawBody: input.rawBody,
      headers: input.headers,
      body: input.body,
      secrets: connection.secrets,
      settings: connection.settings,
    });
    if (!check.ok) {
      throw new AppError('INVALID_API_KEY', check.message ?? 'That delivery could not be verified.', 401);
    }
    return connection;
  }

  /** Meta's one-time handshake, answered by the adapter or refused. */
  async challenge(input: {
    provider: string;
    connectionId: string;
    query: Readonly<Record<string, string | undefined>>;
  }): Promise<string> {
    const connection = await this.integrations.openForInbound(input.provider, input.connectionId);
    const { adapter } = this.registry.require(input.provider);
    if (adapter.challenge === undefined) throw AppError.notFound('Connection');
    const answer = adapter.challenge({
      query: input.query,
      secrets: connection.secrets,
      settings: connection.settings,
    });
    if (answer === null) {
      // 403, not 404: the connection exists and the handshake was refused, which is what Meta's
      // own setup screen reports. A 404 here would send somebody checking the URL they pasted
      // correctly rather than the verify token they typed wrongly.
      throw new AppError(
        'FORBIDDEN',
        'That verification request did not match this connection’s verify token.',
        403,
      );
    }
    return answer;
  }

  /**
   * One delivery, recorded and queued.
   *
   * The insert is attempted per event and its unique violation is **expected**, not exceptional: a
   * retry is the normal case for a provider that did not get our 200. Counting duplicates rather
   * than failing the request is what makes the retry harmless.
   */
  async record(
    connection: InboundConnection,
    events: readonly ProviderDelivery[],
    raw: Record<string, unknown>,
  ): Promise<DeliveryOutcome> {
    let accepted = 0;
    let duplicates = 0;
    let ignored = 0;

    for (const event of events) {
      // A provider's own test ping is acknowledged and recorded, never captured: a test lead in
      // somebody's pipeline is worse than no test at all.
      const isTest = event.eventType === 'test_lead';
      const id = newId();
      try {
        await this.inTenant(connection.organizationId, async () => {
          await this.db.client.providerEvent.create({
            data: {
              id,
              organizationId: connection.organizationId,
              provider: connection.provider,
              connectionId: connection.connectionId,
              externalEventId: event.externalId,
              eventType: event.eventType,
              raw: raw as never,
              status: isTest ? 'processed' : 'received',
              ...(isTest ? { processedAt: new Date() } : {}),
            },
          });
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          duplicates += 1;
          this.logger.debug(
            { provider: connection.provider, externalId: event.externalId },
            'a provider redelivered an event we already have',
          );
          continue;
        }
        throw error;
      }

      if (isTest) {
        ignored += 1;
        continue;
      }
      accepted += 1;
      await this.queues.enqueue(
        QUEUES.MAINTENANCE,
        JOBS.INTEGRATION_INGEST_EVENT,
        { organizationId: connection.organizationId, aggregateId: id },
        // The ledger row's id, so the same event cannot be queued twice while a different event
        // still can. BullMQ rejects ':' in a custom id.
        { jobId: `integration-event-${id}` },
      );
    }

    return { accepted, duplicates, ignored };
  }

  /**
   * One ledger row, turned into a lead.
   *
   * Fetches first when the provider's delivery is only a reference, then goes through
   * `IngestionService.capture` — the one pipeline `FR-CAP-4` asks for, with the never-lose payload
   * store, the duplicate rules, the SLA clock and the timeline. The ledger row's own external id is
   * the capture's idempotency key, so a job delivered twice cannot produce two leads either.
   */
  async ingest(organizationId: string, eventId: string): Promise<void> {
    const row = await this.inTenant(organizationId, async () =>
      this.db.client.providerEvent.findFirst({ where: { id: eventId } }),
    );
    if (!row) {
      this.logger.warn({ eventId }, 'a provider event job has no row');
      return;
    }
    if (row.status === 'processed' || row.status === 'duplicate') return;

    const { provider, adapter } = this.registry.require(row.provider);
    try {
      const connection =
        row.connectionId === null
          ? null
          : await this.integrations.openForInbound(row.provider, row.connectionId);
      if (connection === null) throw AppError.notFound('Connection');

      let payload: Record<string, unknown>;
      if (provider.deliveryIsAReference) {
        if (adapter.fetchLead === undefined) {
          throw new Error(`${provider.key} says its delivery is a reference and cannot fetch`);
        }
        payload = await adapter.fetchLead({
          externalId: row.externalEventId,
          context: {
            connectionId: connection.connectionId,
            organizationId: connection.organizationId,
            secrets: connection.secrets,
            settings: connection.settings,
            externalAccountId: connection.externalAccountId,
          },
        });
      } else {
        const events = adapter.parseDelivery?.((row.raw ?? {}) as Record<string, unknown>) ?? [];
        payload = events.find((event) => event.externalId === row.externalEventId)?.payload ?? {};
      }

      const result = await this.ingestion.capture(
        { organizationId: connection.organizationId, apiKeyRowId: null },
        payload,
        {
          // The bytes a signature was computed over are gone by now, and nothing re-verifies them:
          // what is hashed for the dedupe key is the payload as the ledger holds it.
          rawBody: JSON.stringify(payload),
          // The provider's own id is the key. A job delivered twice is then a replay of the first
          // capture rather than a second lead — belt and braces beside the ledger's unique.
          idempotencyKey: `${row.provider}:${row.externalEventId}`,
          headers: {},
          channel: CHANNELS[row.provider] ?? 'webhook',
          endpoint: `POST /wh/${row.provider}`,
          integrationConnectionId: connection.connectionId,
          mapping: connection.mapping,
          ...(connection.sourceName ? { defaults: { source: connection.sourceName } } : {}),
        },
      );

      await this.inTenant(organizationId, async () => {
        await this.db.client.providerEvent.updateMany({
          where: { id: eventId },
          data: {
            // `duplicate` is the *workspace's* duplicate rules speaking, not a redelivery: the
            // person who filled this form in was already a lead, so the event was accepted and
            // attached rather than creating a second record. A redelivery never reaches here at
            // all — its insert fails the unique, which is the guarantee this table exists for.
            status: result.status === 'duplicate_attached' ? 'duplicate' : 'processed',
            processedAt: new Date(),
            // Only when this event produced a lead **of its own**: a CHECK refuses a `lead_id` on
            // a row that is not `processed`, and an attached touch is honestly not this event's
            // lead.
            ...(result.status === 'created' ? { leadId: result.leadId } : {}),
            attempts: { increment: 1 },
            error: null,
          },
        });
      });
      await this.integrations.recordInboundSuccess(organizationId, connection.connectionId);
      this.logger.info(
        { provider: row.provider, externalId: row.externalEventId, leadId: result.leadId, status: result.status },
        'a provider event became a lead',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
      await this.inTenant(organizationId, async () => {
        await this.db.client.providerEvent.updateMany({
          where: { id: eventId },
          data: { status: 'failed', error: message, attempts: { increment: 1 } },
        });
      });
      // Rethrown, so the queue retries it: the row is the durable record and this is the one place
      // a transient refusal from the provider is worth a second attempt.
      throw error;
    }
  }

  /**
   * The events that have not become leads yet, retried.
   *
   * A sweep over `provider_events_unresolved` rather than a BullMQ delay, for the reason the
   * webhook retry sweep gives: the row is the durable record of what is owed, and a worker that was
   * down while a job expired must not lose the lead. Platform-scoped, so it enters each workspace.
   */
  async sweepUnresolved(limit = 100): Promise<number> {
    const rows = await withPlatformScope(
      'integrations: find provider events that have not become leads',
      async () =>
        this.db.client.providerEvent.findMany({
          where: {
            status: 'failed',
            // Three attempts, then it waits for somebody: a lead Meta will not hand over is a
            // credential problem, and re-asking every minute forever is how a rate limit is earned.
            attempts: { lt: 3 },
          },
          orderBy: { receivedAt: 'asc' },
          take: limit,
          select: { id: true, organizationId: true },
        }),
    );
    for (const row of rows) {
      await this.queues.enqueue(
        QUEUES.MAINTENANCE,
        JOBS.INTEGRATION_INGEST_EVENT,
        { organizationId: row.organizationId, aggregateId: row.id },
        { jobId: `integration-event-retry-${row.id}-${Date.now()}` },
      );
    }
    return rows.length;
  }

  /** The synchronous door: a provider with no event id of its own, captured in the request. */
  async captureInline(
    connection: InboundConnection,
    body: Record<string, unknown>,
    options: { rawBody: string; idempotencyKey: string | undefined; headers: Record<string, string> },
  ) {
    const result = await this.ingestion.capture(
      { organizationId: connection.organizationId, apiKeyRowId: null },
      body,
      {
        rawBody: options.rawBody,
        idempotencyKey: options.idempotencyKey,
        headers: options.headers,
        channel: CHANNELS[connection.provider] ?? 'webhook',
        // Its own key space: the same `Idempotency-Key` sent to the public endpoint and to a
        // connection is two different requests, and sharing one would make the second a replay.
        endpoint: 'POST /wh/{provider}/{connectionId}',
        integrationConnectionId: connection.connectionId,
        mapping: connection.mapping,
        ...(connection.sourceName ? { defaults: { source: connection.sourceName } } : {}),
      },
    );
    // Only once the lead is in: `last_success_at` is the only evidence an inbound connection is
    // working, so it must mean "something arrived and became a lead" rather than "a request was
    // signed correctly".
    await this.integrations.recordInboundSuccess(
      connection.organizationId,
      connection.connectionId,
    );
    return result;
  }

  /** The adapter's own reading of a delivery: zero or more events with the provider's own ids. */
  parse(provider: string, body: Record<string, unknown>): readonly ProviderDelivery[] {
    const { adapter } = this.registry.require(provider);
    return adapter.parseDelivery?.(body) ?? [];
  }

  /** The provider's own label, for a message a person reads. */
  label(provider: string): string {
    return findProvider(provider)?.label ?? provider;
  }

  private inTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(systemPrincipal(organizationId, newId()), fn);
  }
}

/** Whether a write failed because the ledger already had this event. Prisma's own code for it. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002';
}
