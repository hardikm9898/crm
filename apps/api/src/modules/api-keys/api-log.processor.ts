import { Inject, Injectable } from '@nestjs/common';
import {
  API_LOG_PARTITION_DAYS_AHEAD,
  API_LOG_RETENTION_DAYS,
  withPlatformScope,
} from '@leados/shared';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';

/**
 * Keeps `api_logs` partitioned a week ahead, and drops the days past retention
 * (`maintenance.api-log-partitions`).
 *
 * Its own job rather than a fourth table inside the monthly partition sweep, because the cadence is
 * the thing that differs: these partitions are **days**, and this is also the only one of them that
 * **deletes**. Thirty days of request logs is a debugging tool; a year of them is a second copy of
 * who called the API and when, kept for nobody.
 *
 * Dropping a partition rather than deleting rows is the whole reason the table is partitioned by
 * day: `DELETE FROM api_logs WHERE created_at < …` on a busy workspace is a statement that holds a
 * lock for minutes and leaves the space behind. `DROP TABLE` on one day's partition is instant.
 *
 * It runs **before** the day it is needed, and tolerates its own failure: a day with no partition
 * sends rows to `api_logs_default`, where they are readable and merely block attaching that day
 * later — which the job reports rather than hides.
 */
@Injectable()
export class ApiLogPartitionProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.API_LOG_PARTITIONS;

  constructor(
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(_payload: JobPayload, _job: Job): Promise<void> {
    await withPlatformScope('maintenance: api log partitions', async () => {
      const created: string[] = [];
      // From yesterday, because a row written as the clock crosses midnight belongs to the day
      // that has just ended.
      for (let day = -1; day <= API_LOG_PARTITION_DAYS_AHEAD; day += 1) {
        const target = new Date(Date.now() + day * 86_400_000);
        const [row] = await this.db.client.$queryRaw<{ ensure_api_log_partition: string }[]>`
          SELECT ensure_api_log_partition(${target}::timestamptz)
        `;
        if (row) created.push(row.ensure_api_log_partition);
      }

      const dropped = await this.dropExpiredPartitions();

      const [stranded] = await this.db.client.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM api_logs_default
      `;
      const strandedCount = Number(stranded?.count ?? 0n);
      if (strandedCount > 0) {
        this.logger.warn(
          { strandedCount },
          'api log rows are sitting in the default partition; they block attaching the days they belong to',
        );
      }

      this.logger.info(
        { partitions: created.length, dropped, retentionDays: API_LOG_RETENTION_DAYS },
        'api log partitions maintained',
      );
    });
  }

  /**
   * Drops the day partitions wholly older than the retention window.
   *
   * The name carries the date (`api_logs_20261018`), so the decision is made from the catalogue
   * rather than by reading a row out of each partition — and the cutoff is compared against the
   * day the partition **covers**, so the oldest kept day is always a whole one.
   */
  private async dropExpiredPartitions(): Promise<number> {
    const cutoff = new Date(Date.now() - API_LOG_RETENTION_DAYS * 86_400_000);
    const stamp = cutoff.toISOString().slice(0, 10).replace(/-/g, '');

    const partitions = await this.db.client.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'api_logs'::regclass
        AND c.relname ~ '^api_logs_[0-9]{8}$'
    `;

    let dropped = 0;
    for (const partition of partitions) {
      const day = partition.relname.slice('api_logs_'.length);
      if (day >= stamp) continue;
      // `api_logs_default` cannot match the pattern above, so there is no way for this to drop the
      // partition that catches rows nothing else would accept.
      await this.db.client.$executeRawUnsafe(`DROP TABLE IF EXISTS "${partition.relname}"`);
      dropped += 1;
      this.logger.info({ partition: partition.relname }, 'dropped an expired api log partition');
    }
    return dropped;
  }
}
