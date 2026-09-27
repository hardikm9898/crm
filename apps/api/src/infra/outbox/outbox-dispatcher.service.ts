import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Client } from 'pg';
import { withPlatformScope } from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../db/db.service.js';
import { LOGGER } from '../observability/logger.module.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { QueueService } from '../queue/queue.service.js';
import { outboxJobId, subscribersFor } from './event-subscriptions.js';

/**
 * Moves committed domain events onto queues (ADR-0006).
 *
 * The contract is at-least-once: an event is enqueued, *then* marked published. If the process
 * dies in between, the event is picked up again and re-enqueued — which is why every consumer
 * must be idempotent on `eventId`. The alternative ordering (mark, then enqueue) would lose
 * events, and losing a `lead.created` event means a lead with no owner and no follow-up, which
 * is the exact failure this product exists to prevent.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, so several dispatcher replicas can run without
 * double-handling a row. Polling is the durable path; `LISTEN/NOTIFY` only wakes the loop early
 * so latency is sub-second rather than one poll interval.
 */
const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 10;

interface OutboxRow {
  id: string;
  event_id: string;
  organization_id: string | null;
  event_name: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  attempts: number;
}

@Injectable()
export class OutboxDispatcherService implements OnApplicationShutdown {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private listener: Client | null = null;
  private wakeRequested = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly queues: QueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.startListener();
    this.scheduleNextTick(0);
    this.logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'outbox dispatcher started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
    if (this.listener) {
      await this.listener.end().catch(() => undefined);
      this.listener = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Dispatches one batch. Exposed so tests can drive the dispatcher deterministically instead
   * of waiting on a timer.
   *
   * @returns how many events were published.
   */
  async dispatchBatch(): Promise<number> {
    return withPlatformScope('outbox: dispatch batch', async () => {
      // One transaction per batch: rows are claimed with SKIP LOCKED so concurrent dispatchers
      // take disjoint sets, and the claim is released if this process dies mid-batch.
      return this.db.client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, event_id, organization_id, event_name, aggregate_type, aggregate_id,
                 payload, correlation_id, attempts
          FROM outbox_events
          WHERE published_at IS NULL AND attempts < ${MAX_ATTEMPTS}
          ORDER BY occurred_at
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        `;

        let published = 0;
        for (const row of rows) {
          try {
            await this.enqueueSubscribers(row);
            await tx.$executeRaw`
              UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = ${row.id}::uuid
            `;
            published += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown error';
            // The row stays unpublished and its attempt count rises; after MAX_ATTEMPTS it stops
            // being retried and is surfaced by the reaper instead of spinning forever.
            await tx.$executeRaw`
              UPDATE outbox_events
              SET attempts = attempts + 1, last_error = ${message.slice(0, 1_000)}
              WHERE id = ${row.id}::uuid
            `;
            this.logger.error(
              {
                eventId: row.event_id,
                eventName: row.event_name,
                attempts: row.attempts + 1,
                err: message,
              },
              'failed to dispatch outbox event',
            );
          }
        }
        return published;
      });
    });
  }

  private async enqueueSubscribers(row: OutboxRow): Promise<void> {
    for (const subscription of subscribersFor(row.event_name)) {
      await this.queues.enqueue(
        subscription.queue,
        subscription.jobName,
        {
          organizationId: row.organization_id,
          correlationId: row.correlation_id ?? undefined,
          // Derived from the event, not the attempt: two dispatches of the same event collapse
          // into one job (docs/queue-event-architecture.md §4).
          idempotencyKey: row.event_id,
          eventId: row.event_id,
          eventName: row.event_name,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: row.payload,
        },
        { jobId: outboxJobId(subscription.jobName, row.event_id) },
      );
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
      void this.inFlight;
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      const published = await this.dispatchBatch();
      // A full batch probably means more is waiting, so come straight back.
      const nextDelay = published >= BATCH_SIZE ? 0 : this.wakeRequested ? 0 : POLL_INTERVAL_MS;
      this.wakeRequested = false;
      this.scheduleNextTick(nextDelay);
    } catch (error) {
      this.logger.error({ err: error }, 'outbox dispatcher tick failed');
      // Back off slightly on an unexpected failure rather than hammering a broken database.
      this.scheduleNextTick(POLL_INTERVAL_MS * 5);
    }
  }

  /**
   * `LISTEN outbox_event` (see the hardening migration's trigger) turns "up to one poll interval"
   * into "as soon as the writer commits". If the listener dies, polling still carries everything.
   */
  private async startListener(): Promise<void> {
    try {
      const client = new Client({ connectionString: this.config.DATABASE_URL });
      await client.connect();
      await client.query('LISTEN outbox_event');
      client.on('notification', () => {
        this.wakeRequested = true;
      });
      client.on('error', (error) => {
        this.logger.warn({ err: error.message }, 'outbox listener dropped; polling continues');
      });
      this.listener = client;
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : error },
        'could not start outbox listener; falling back to polling only',
      );
    }
  }
}
