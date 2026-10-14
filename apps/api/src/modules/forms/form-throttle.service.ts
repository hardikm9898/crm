import { Injectable } from '@nestjs/common';
import { AppError } from '@leados/shared';
import { RedisService } from '../../infra/redis/redis.service.js';

/**
 * The rate limit on a public form (`FR-CAP-2`).
 *
 * Two counters, for the reason the login throttle has two: one form being hammered and one address
 * trying every form are different attacks, and a limit that only counted one of them would stop
 * neither. The per-form ceiling is generous — a popular enquiry form on a busy launch day is real
 * traffic — and the per-address one is tight, because nobody fills in the same form forty times in
 * an hour.
 *
 * **Fails closed**, like the login throttle: if Redis is unavailable we cannot count, and an
 * unlimited public write endpoint is the worse outcome. The refusal says to try again shortly,
 * which is true either way.
 */
const FORM_LIMIT = 300;
const FORM_WINDOW_SECONDS = 3600;
const ADDRESS_LIMIT = 10;
const ADDRESS_WINDOW_SECONDS = 3600;

@Injectable()
export class FormThrottleService {
  constructor(private readonly redis: RedisService) {}

  async assertAllowed(formId: string, ipHash: string | null): Promise<void> {
    try {
      const formCount = await this.redis.increment(this.formKey(formId), FORM_WINDOW_SECONDS);
      if (formCount > FORM_LIMIT) throw this.tooMany(await this.redis.ttl(this.formKey(formId)));

      if (ipHash) {
        const addressCount = await this.redis.increment(
          this.addressKey(formId, ipHash),
          ADDRESS_WINDOW_SECONDS,
        );
        if (addressCount > ADDRESS_LIMIT) {
          throw this.tooMany(await this.redis.ttl(this.addressKey(formId, ipHash)));
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'RATE_LIMITED',
        'This form is temporarily unavailable. Please try again shortly.',
        429,
      );
    }
  }

  private tooMany(ttlSeconds: number): AppError {
    const seconds = ttlSeconds > 0 ? ttlSeconds : ADDRESS_WINDOW_SECONDS;
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return new AppError(
      'RATE_LIMITED',
      `That form has had a lot of submissions. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      429,
      { retryAfterSeconds: seconds },
    );
  }

  // Keyed with no organization: the counter exists before the tenant is known to the caller, and
  // the form id is already unique across the platform.
  private formKey(formId: string): string {
    return this.redis.key(null, 'form', 'rate', formId);
  }

  private addressKey(formId: string, ipHash: string): string {
    return this.redis.key(null, 'form', 'rate', formId, ipHash);
  }
}
