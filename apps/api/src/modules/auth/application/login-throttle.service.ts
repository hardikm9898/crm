import { Injectable } from '@nestjs/common';
import { AppError } from '@leados/shared';
import { RedisService } from '../../../infra/redis/redis.service.js';
import { requestStore } from '../../../infra/http/request-store.js';

/**
 * Brute-force and credential-stuffing resistance for the authentication endpoints
 * (docs/security.md §2, §11).
 *
 * Two independent counters, because the two attacks look different:
 *  • **per account** stops someone grinding one user's password;
 *  • **per IP** stops someone trying one password against many accounts.
 *
 * Lockout is temporary and per-window rather than permanent: a permanent lock on failed
 * attempts is itself a denial-of-service against the real user.
 *
 * Failing closed matters here. If Redis is unavailable we cannot count attempts, and
 * allowing unlimited guesses is the worse outcome for a login endpoint, so the attempt
 * is rejected with a retryable error.
 */
const ACCOUNT_LIMIT = 8;
const ACCOUNT_WINDOW_SECONDS = 900; // 15 minutes
const IP_LIMIT = 30;
const IP_WINDOW_SECONDS = 900;

@Injectable()
export class LoginThrottleService {
  constructor(private readonly redis: RedisService) {}

  async assertAllowed(identifier: string): Promise<void> {
    const ip = requestStore.get()?.ip ?? 'unknown';
    try {
      const [accountCount, ipCount] = await Promise.all([
        this.count(this.accountKey(identifier)),
        this.count(this.ipKey(ip)),
      ]);

      if (accountCount >= ACCOUNT_LIMIT) {
        throw this.lockedOut(await this.redis.ttl(this.accountKey(identifier)));
      }
      if (ipCount >= IP_LIMIT) {
        throw this.lockedOut(await this.redis.ttl(this.ipKey(ip)));
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'RATE_LIMITED',
        'Sign-in is temporarily unavailable. Please try again shortly.',
        429,
      );
    }
  }

  async recordFailure(identifier: string): Promise<void> {
    const ip = requestStore.get()?.ip ?? 'unknown';
    await Promise.all([
      this.redis.increment(this.accountKey(identifier), ACCOUNT_WINDOW_SECONDS),
      this.redis.increment(this.ipKey(ip), IP_WINDOW_SECONDS),
    ]);
  }

  /** A successful sign-in clears the account counter, not the IP one. */
  async recordSuccess(identifier: string): Promise<void> {
    await this.redis.del(this.accountKey(identifier));
  }

  private async count(key: string): Promise<number> {
    const value = await this.redis.client.get(key);
    return value === null ? 0 : Number(value);
  }

  private lockedOut(ttlSeconds: number): AppError {
    const minutes = Math.max(
      1,
      Math.ceil((ttlSeconds > 0 ? ttlSeconds : ACCOUNT_WINDOW_SECONDS) / 60),
    );
    return new AppError(
      'RATE_LIMITED',
      `Too many sign-in attempts. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      429,
      { retryAfterSeconds: ttlSeconds > 0 ? ttlSeconds : ACCOUNT_WINDOW_SECONDS },
    );
  }

  private accountKey(identifier: string): string {
    return this.redis.key(null, 'auth', 'fail', 'account', identifier.toLowerCase());
  }

  private ipKey(ip: string): string {
    return this.redis.key(null, 'auth', 'fail', 'ip', ip);
  }
}
