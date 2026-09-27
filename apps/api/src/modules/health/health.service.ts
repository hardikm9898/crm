import { Inject, Injectable } from '@nestjs/common';
import { withPlatformScope } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
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
    const database = await this.check(() => this.db.ping());
    const components = { database };
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
    const [migrations, outbox] = await withPlatformScope('health: platform diagnostics', async () =>
      Promise.all([this.migrationState(), this.outboxLag()]),
    );

    return { ...readiness, migrations, outbox };
  }

  private async check(probe: () => Promise<number>): Promise<ComponentHealth> {
    try {
      const latencyMs = await probe();
      return { status: latencyMs > 1_000 ? 'degraded' : 'up', latencyMs };
    } catch (error) {
      return { status: 'down', detail: error instanceof Error ? error.message : 'unknown error' };
    }
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
