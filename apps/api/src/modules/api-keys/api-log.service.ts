import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { newId, statusClass, withPlatformScope, type StatusClass } from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import type { ListApiLogsQuery } from './api-logs.dto.js';

/** One request, as the response hook saw it. Nothing here is read from the body. */
export interface ApiLogEntry {
  readonly organizationId: string;
  readonly apiKeyId: string | null;
  readonly surface: 'rest' | 'public_ingest';
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

/** Rows are flushed when either of these is reached, whichever comes first. */
export const FLUSH_AFTER_ROWS = 100;
export const FLUSH_AFTER_MS = 1_000;
/**
 * The ceiling on the buffer. Beyond it, rows are dropped and the drop is counted and logged:
 * holding an unbounded queue of log rows while the database is unavailable would turn a logging
 * outage into a memory one, and the request log is the thing of least value in that moment.
 */
export const BUFFER_LIMIT = 5_000;

/**
 * The request log (`FR-API-1`, `FR-SA-4`): writing it, and reading it back.
 *
 * **Buffered, and incapable of failing a request.** One insert per request would double the write
 * volume of a read-only endpoint, and an insert *inside* the request would make every answer wait
 * on the log of itself — so rows are collected and flushed in batches of a hundred or every second,
 * whichever comes first. The lesson the ingestion recorder paid for applies with more force here: a
 * recorder of what happened must not be able to change what happened, so every failure in this file
 * is logged and swallowed.
 *
 * The buffer is in process memory, which is the honest cost: a `SIGKILL` loses up to a second of
 * log rows. `onApplicationShutdown` flushes on an orderly stop, and the alternative — a durable
 * queue in front of a debugging log — would be a second outbox for data whose value expires in
 * thirty days.
 */
@Injectable()
export class ApiLogService implements OnApplicationShutdown {
  private buffer: ApiLogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private dropped = 0;

  constructor(
    private readonly db: DbService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Never throws, never awaits the write: called from a Fastify `onResponse` hook. */
  record(entry: ApiLogEntry): void {
    if (this.buffer.length >= BUFFER_LIMIT) {
      this.dropped += 1;
      return;
    }
    this.buffer.push(entry);
    if (this.buffer.length >= FLUSH_AFTER_ROWS) {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_AFTER_MS).unref();
  }

  /** Writes whatever is buffered. Exposed so a test does not have to wait a second for a row. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    if (batch.length === 0) return;
    this.buffer = [];

    const droppedSinceLastFlush = this.dropped;
    this.dropped = 0;
    if (droppedSinceLastFlush > 0) {
      // Counted and said out loud: a log with a silent hole in it is worse than one with a gap it
      // admits to.
      this.logger.warn(
        { dropped: droppedSinceLastFlush },
        'api log rows were dropped: the buffer was full',
      );
    }

    try {
      // Across tenants in one statement, because a batch spans workspaces. Each row carries its
      // own `organization_id`, which is what the scoping extension would otherwise supply.
      await withPlatformScope('api log: flush a batch of request rows', async () => {
        await this.db.client.apiLog.createMany({
          data: batch.map((entry) => ({
            id: newId(),
            organizationId: entry.organizationId,
            apiKeyId: entry.apiKeyId,
            surface: entry.surface,
            method: entry.method,
            path: entry.path,
            statusCode: entry.statusCode,
            errorCode: entry.errorCode,
            durationMs: entry.durationMs,
            bytesIn: entry.bytesIn,
            bytesOut: entry.bytesOut,
            requestId: entry.requestId,
            ip: entry.ip,
            userAgent: entry.userAgent,
            createdAt: entry.createdAt,
          })),
        });
      });
    } catch (error) {
      // Swallowed deliberately. The rows are gone; the requests they describe already succeeded.
      this.logger.error({ err: error, rows: batch.length }, 'an api log batch could not be written');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flush();
  }

  /**
   * The workspace's recent requests, newest first, with a summary **over the same filter**.
   *
   * The summary is in `meta` rather than on a second endpoint for the reason this codebase has
   * learned twice: a figure beside a filtered list that is not itself filtered is the recurring bug
   * here, and one read cannot disagree with itself.
   */
  async list(query: ListApiLogsQuery) {
    const since = query.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const where = {
      createdAt: { gte: since },
      ...(query.apiKeyId ? { apiKeyId: query.apiKeyId } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.status === undefined ? {} : statusFilter(query.status)),
    };

    const [rows, grouped, aggregate] = await Promise.all([
      this.db.client.apiLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit ?? 50,
        include: { apiKey: { select: { id: true, name: true, keyPrefix: true } } },
      }),
      // The whole window, by key — not the page. A list capped at fifty rows beside a count of
      // fifty would tell a workspace their integration made fifty requests today.
      this.db.client.apiLog.groupBy({
        by: ['statusCode'],
        where,
        _count: { _all: true },
        _avg: { durationMs: true },
      }),
      this.db.client.apiLog.aggregate({ where, _count: { _all: true }, _max: { durationMs: true } }),
    ]);

    const byClass = new Map<StatusClass, number>();
    let weightedDuration = 0;
    for (const group of grouped) {
      const count = group._count._all;
      const cls = statusClass(group.statusCode);
      byClass.set(cls, (byClass.get(cls) ?? 0) + count);
      weightedDuration += (group._avg.durationMs ?? 0) * count;
    }
    const total = aggregate._count._all;

    return {
      items: rows.map((row) => ({
        id: row.id,
        apiKey: row.apiKey
          ? { id: row.apiKey.id, name: row.apiKey.name, keyPrefix: row.apiKey.keyPrefix }
          : null,
        surface: row.surface,
        method: row.method,
        path: row.path,
        statusCode: row.statusCode,
        errorCode: row.errorCode,
        durationMs: row.durationMs,
        bytesIn: row.bytesIn,
        bytesOut: row.bytesOut,
        requestId: row.requestId,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: {
        since: since.toISOString(),
        summary: {
          requests: total,
          succeeded: byClass.get('success') ?? 0,
          refused: byClass.get('client_error') ?? 0,
          failed: byClass.get('server_error') ?? 0,
          averageDurationMs: total === 0 ? null : Math.round(weightedDuration / total),
          slowestDurationMs: aggregate._max.durationMs ?? null,
        },
      },
      pagination: {
        limit: query.limit ?? 50,
        nextCursor: null,
        hasMore: total > rows.length,
        total,
      },
    };
  }

  /** What each key has been doing lately, for the row beside it on the screen. */
  async usageByKey(windowHours = 24) {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const grouped = await this.db.client.apiLog.groupBy({
      by: ['apiKeyId'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const refusals = await this.db.client.apiLog.groupBy({
      by: ['apiKeyId'],
      where: { createdAt: { gte: since }, statusCode: { gte: 400 } },
      _count: { _all: true },
    });
    const refusedByKey = new Map(refusals.map((row) => [row.apiKeyId, row._count._all]));

    return grouped.map((row) => ({
      apiKeyId: row.apiKeyId,
      requests: row._count._all,
      refused: refusedByKey.get(row.apiKeyId) ?? 0,
      lastRequestAt: row._max.createdAt?.toISOString() ?? null,
    }));
  }

}

function statusFilter(status: StatusClass) {
  switch (status) {
    case 'success':
      return { statusCode: { gte: 200, lt: 400 } };
    case 'client_error':
      return { statusCode: { gte: 400, lt: 500 } };
    case 'server_error':
      return { statusCode: { gte: 500 } };
    default:
      return {};
  }
}
