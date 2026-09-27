import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';

/**
 * Redis is used for cache, rate limits, locks and (from Phase 1 step 4) BullMQ.
 *
 * Every key is built through `key()`, which requires an organization id for anything
 * tenant-scoped — a cache key without one is how a cache becomes a cross-tenant leak
 * (docs/system-architecture.md §9).
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      // Commands issued while Redis is down should fail fast rather than queue forever:
      // a degraded cache must not turn into a hung request.
      enableOfflineQueue: false,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 2_000),
    });
    // Without a listener, a connection error becomes an unhandled 'error' event and
    // takes the process down. Degrade instead: reads fall back to the database.
    this.client.on('error', () => undefined);
  }

  /**
   * Waits for the connection to become usable.
   *
   * Necessary because `enableOfflineQueue: false` makes any command issued before the
   * handshake completes fail immediately — correct for request-path commands (fail fast
   * beats hanging), wrong for a readiness probe running moments after boot.
   */
  async waitUntilReady(timeoutMs = 2_000): Promise<boolean> {
    if (this.client.status === 'ready') return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.client.off('ready', onReady);
        resolve(false);
      }, timeoutMs);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.client.once('ready', onReady);
    });
  }

  async ping(): Promise<number> {
    const ready = await this.waitUntilReady();
    if (!ready) throw new Error(`Redis is not ready (status: ${this.client.status})`);
    const startedAt = performance.now();
    await this.client.ping();
    return Math.round(performance.now() - startedAt);
  }

  /** Tenant-scoped key. Pass `null` only for genuinely platform-wide values. */
  key(organizationId: string | null, ...parts: (string | number)[]): string {
    const prefix = organizationId === null ? 'platform' : `org:${organizationId}`;
    return [prefix, ...parts].join(':');
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null; // a cache miss and a cache outage are the same thing to a caller
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      /* cache writes are best-effort */
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Fixed-window counter used by the auth throttles. Returns the count after
   * incrementing, so the caller decides what to do at the threshold.
   */
  async increment(key: string, windowSeconds: number): Promise<number> {
    const pipeline = this.client.multi();
    pipeline.incr(key);
    pipeline.expire(key, windowSeconds, 'NX');
    const results = await pipeline.exec();
    const value = results?.[0]?.[1];
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch {
      return -1;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.client.disconnect();
  }
}
