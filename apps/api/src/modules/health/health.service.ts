import { Inject, Injectable } from '@nestjs/common';
import { withPlatformScope } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { RedisService } from '../../infra/redis/redis.service.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';

export type ComponentStatus = 'up' | 'degraded' | 'down';

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
}

interface OutboxLagRow {
  count: bigint;
  oldest: Date | null;
}

export interface ComponentHealth {
  readonly status: ComponentStatus;
  readonly latencyMs?: number;
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly status: ComponentStatus;
  readonly components: Record<string, ComponentHealth>;
}

export interface DeepHealthReport extends ReadinessReport {
  readonly migrations: { readonly applied: number; readonly pending: string[] };
  readonly outbox: {
    readonly unpublished: number;
    readonly oldestUnpublishedAgeSeconds: number | null;
  };
  readonly queues: Record<string, Record<string, number>>;
  readonly jobs: { readonly deadLettered: number; readonly oldestWaitingAgeSeconds: number | null };
  readonly scheduler: { readonly instances: number; readonly lastBeatAgeSeconds: number | null };
}

/**
 * Health is reported at three depths (docs/deployment-architecture.md §7):
 *   live  — the process is up (no dependencies touched)
 *   ready — dependencies this process needs to serve traffic
 *   deep  — operational detail for the Super Admin system-health page
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly queues: QueueService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  liveness(): { status: 'ok'; role: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      role: this.config.ROLE,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const [database, cache] = await Promise.all([
      this.check(() => this.db.ping()),
      this.check(() => this.redis.ping()),
    ]);
    const components = { database, cache };
    const status: ComponentStatus = Object.values(components).some((c) => c.status === 'down')
      ? 'down'
      : Object.values(components).some((c) => c.status === 'degraded')
        ? 'degraded'
        : 'up';
    return { status, components };
  }

  async deep(): Promise<DeepHealthReport> {
    const readiness = await this.readiness();

    // Platform-scoped: these reads deliberately span tenants, and saying so explicitly
    // is what keeps the bypass reviewable.
    const [migrations, outbox, jobs, scheduler] = await withPlatformScope(
      'health: platform diagnostics',
      async () =>
        Promise.all([
          this.migrationState(),
          this.outboxLag(),
          this.jobState(),
          this.schedulerState(),
        ]),
    );

    // Queue counts come from Redis, not the database, so they sit outside the platform scope.
    const queues = await this.queues.counts().catch(() => ({}));

    return { ...readiness, migrations, outbox, queues, jobs, scheduler };
  }

  private async check(probe: () => Promise<number>): Promise<ComponentHealth> {
    try {
      const latencyMs = await probe();
      return { status: latencyMs > 1_000 ? 'degraded' : 'up', latencyMs };
    } catch (error) {
      return { status: 'down', detail: error instanceof Error ? error.message : 'unknown error' };
    }
  }

  /**
   * Dead-lettered jobs and the oldest waiting job: the pair that distinguishes "busy" from
   * "stuck" (docs/deployment-architecture.md §7).
   */
  private async jobState(): Promise<{
    deadLettered: number;
    oldestWaitingAgeSeconds: number | null;
  }> {
    const [deadLettered, oldestWaitingAgeSeconds] = await Promise.all([
      this.db.client.jobFailure.count({ where: { retriedAt: null } }),
      this.queues.oldestWaitingAgeSeconds().catch(() => null),
    ]);
    return { deadLettered, oldestWaitingAgeSeconds };
  }

  /**
   * A scheduler fails silently — the only symptom is that something which should have run did
   * not — so its heartbeat age is reported explicitly.
   */
  private async schedulerState(): Promise<{
    instances: number;
    lastBeatAgeSeconds: number | null;
  }> {
    const since = new Date(Date.now() - 5 * 60_000);
    const [instances, latest] = await Promise.all([
      this.db.client.schedulerHeartbeat.count({ where: { lastBeatAt: { gte: since } } }),
      this.db.client.schedulerHeartbeat.findFirst({ orderBy: { lastBeatAt: 'desc' } }),
    ]);
    return {
      instances,
      lastBeatAgeSeconds: latest
        ? Math.round((Date.now() - latest.lastBeatAt.getTime()) / 1_000)
        : null,
    };
  }

  private async migrationState(): Promise<{ applied: number; pending: string[] }> {
    const rows: MigrationRow[] = await this.db.client.$queryRaw`
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at
    `;
    return {
      applied: rows.filter((row) => row.finished_at !== null).length,
      pending: rows.filter((row) => row.finished_at === null).map((row) => row.migration_name),
    };
  }

  /**
   * Outbox lag is the single most important internal signal: if it grows, domain events
   * are not reaching their consumers and follow-ups, notifications and WhatsApp sends
   * are silently not happening (ADR-0006).
   */
  private async outboxLag(): Promise<{
    unpublished: number;
    oldestUnpublishedAgeSeconds: number | null;
  }> {
    const rows: OutboxLagRow[] = await this.db.client.$queryRaw`
      SELECT COUNT(*)::bigint AS count, MIN(occurred_at) AS oldest
      FROM outbox_events WHERE published_at IS NULL
    `;
    const row = rows[0];
    const oldest = row?.oldest ?? null;
    return {
      unpublished: Number(row?.count ?? 0n),
      oldestUnpublishedAgeSeconds: oldest
        ? Math.round((Date.now() - oldest.getTime()) / 1000)
        : null,
    };
  }
}
