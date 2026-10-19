import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { RedisService } from '../../infra/redis/redis.service.js';

/**
 * Per-number send throughput (`FR-WA-9`).
 *
 * Meta rate-limits **per phone number**, not per app, and answers a 429 with no useful retry hint.
 * So the limit is ours to keep: a fixed one-second window per `phone_number_id` in Redis, checked
 * by the send processor before it calls Meta.
 *
 * Deliberately a *fixed* window rather than a token bucket. A bucket's refill is state in two
 * places — the count and the instant it was last touched — and a sliding window needs a sorted set
 * per number; this needs one `INCR` and one `EXPIRE`, which is the shape `RedisService.increment`
 * already has for the auth throttles. The cost is that two bursts either side of a second boundary
 * can both pass, which Meta tolerates and a tighter implementation would pay for in complexity
 * nobody asked for.
 *
 * **Redis being down must not stop a send.** `increment` answers 0 on a failure, which reads as
 * "under the limit": the alternative is a product that cannot reply to customers because a cache is
 * unavailable, and Meta's own 429 is the backstop either way.
 */
@Injectable()
export class WhatsAppRateLimiter {
  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Whether this number may send right now, and how long to wait if not. */
  async take(phoneNumberId: string): Promise<{ allowed: true } | { allowed: false; retryInMs: number }> {
    const limit = this.config.WHATSAPP_SENDS_PER_SECOND;
    if (limit <= 0) return { allowed: true };
    const second = Math.floor(Date.now() / 1000);
    const key = `wa:send-rate:${phoneNumberId}:${second}`;
    const count = await this.redis.increment(key, 2);
    if (count <= limit) return { allowed: true };
    this.logger.debug({ phoneNumberId, count, limit }, 'whatsapp send rate limit reached');
    // To the start of the next second, plus a little: a job that wakes inside the same window would
    // find the counter exactly where it left it.
    return { allowed: false, retryInMs: 1_000 - (Date.now() % 1_000) + 50 };
  }
}
