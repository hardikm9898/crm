import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  verifySignature,
  withPlatformScope,
  type ApiKeyScope,
  type SignatureFailure,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { EncryptionService } from '../../infra/crypto/encryption.service.js';
import { RedisService } from '../../infra/redis/redis.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';

/** What the caller turned out to be. Everything downstream works from this, not from headers. */
export interface AuthenticatedCaller {
  readonly organizationId: string;
  readonly apiKeyRowId: string;
  readonly keyId: string;
  readonly scopes: readonly ApiKeyScope[];
}

/** Requests per minute when a key does not set its own. Generous: a launch day is real traffic. */
export const DEFAULT_RATE_LIMIT_PER_MIN = 120;

/** The AAD the secret's ciphertext is bound to, so it cannot be moved to another key's row. */
export function apiKeyAad(id: string): string {
  return `api_key:${id}`;
}

/**
 * Who is calling the public lead API, and may they (`FR-CAP-6`, `FR-API-2`).
 *
 * The order of the checks is the decision in this file:
 *
 *  1. **The workspace's public key**, from the path. Wrong key ⇒ 404 — the same answer a workspace
 *     that never existed gets, because anything else is an oracle for "which businesses are here".
 *  2. **The API key**, from `X-Api-Key`. Unknown, revoked, expired, or belonging to a *different*
 *     workspace ⇒ one indistinguishable `401 INVALID_API_KEY`. A real key for workspace A posting
 *     at workspace B's path is the attack that last check exists for.
 *  3. **The IP allowlist**, before the signature: it costs nothing, and an address that is not
 *     allowed should learn nothing about whether its signature was right.
 *  4. **The scope**, then the workspace's own standing (a suspended workspace cannot take leads
 *     nobody will be able to read), then **the rate limit** — counted before the signature is
 *     checked, so grinding signatures costs an attacker requests.
 *  5. **The signature** over the raw body.
 *
 * The secret is **decrypted** to verify the HMAC, which is the whole reason it is stored encrypted
 * rather than hashed: a receiver of signed requests has to hold the shared secret (ADR-0030).
 */
@Injectable()
export class IngestAuthService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async authenticate(input: {
    organizationPublicKey: string;
    presentedKeyId: string | undefined;
    signatureHeader: string | undefined;
    rawBody: string;
    ip: string | undefined;
  }): Promise<AuthenticatedCaller> {
    // Across tenants, because the path is the only thing that says which workspace this is — and
    // audited by the reason string, as every platform-scoped read in this codebase is.
    const organization = await withPlatformScope(
      'public ingestion: resolve the workspace from its public key',
      async () =>
        this.db.client.organization.findFirst({
          where: { publicKey: input.organizationPublicKey.trim() },
          select: { id: true, status: true },
        }),
    );
    if (!organization) throw AppError.notFound('Workspace');

    const presented = input.presentedKeyId?.trim() ?? '';
    if (presented === '') throw this.badKey('No API key was presented. Send it as X-Api-Key.');

    const key = await withPlatformScope('public ingestion: resolve the API key', async () =>
      this.db.client.apiKey.findFirst({
        where: { keyId: presented },
        select: {
          id: true,
          organizationId: true,
          keyId: true,
          secretEncrypted: true,
          scopes: true,
          ipAllowlist: true,
          rateLimitPerMin: true,
          expiresAt: true,
          revokedAt: true,
        },
      }),
    );

    if (
      !key ||
      key.organizationId !== organization.id ||
      key.revokedAt !== null ||
      (key.expiresAt !== null && key.expiresAt <= new Date())
    ) {
      throw this.badKey('That API key is not valid for this workspace.');
    }

    if (!this.addressAllowed(key.ipAllowlist, input.ip)) {
      throw new AppError(
        'FORBIDDEN',
        'This key only accepts requests from the addresses on its allowlist, and this request did not come from one.',
        403,
      );
    }

    if (!key.scopes.includes('ingest:write')) {
      throw new AppError(
        'PERMISSION_DENIED',
        'This key cannot create leads. Give it the ingest:write scope.',
        403,
      );
    }

    if (organization.status === 'suspended' || organization.status === 'cancelled') {
      // A lead accepted into a workspace nobody can read is a lead that was lost politely.
      throw new AppError(
        'ORG_SUSPENDED',
        'This workspace is not currently accepting leads. Please contact the business directly.',
        403,
      );
    }

    await this.assertWithinRate(key.id, key.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN);

    const secret = this.decryptSecret(key.id, key.secretEncrypted);
    const check = verifySignature(secret, input.signatureHeader, input.rawBody);
    if (!check.ok) {
      throw new AppError(
        'INVALID_API_KEY',
        IngestAuthService.signatureMessage(check.failure ?? 'mismatch'),
        401,
      );
    }

    // Recorded after the request is accepted and outside any transaction the capture opens: "is
    // this key still in use" has to be answerable before somebody revokes it, and a failed capture
    // does not make the credential unused.
    await this.recordUse(key.id, input.ip);

    return {
      organizationId: organization.id,
      apiKeyRowId: key.id,
      keyId: key.keyId,
      scopes: key.scopes as ApiKeyScope[],
    };
  }

  /** Whether a request from `ip` is allowed by a key's allowlist. An empty list allows everything. */
  addressAllowed(allowlist: readonly string[], ip: string | undefined): boolean {
    if (allowlist.length === 0) return true;
    if (!ip) return false;
    return allowlist.some((entry) => matchesCidr(entry, ip));
  }

  private decryptSecret(id: string, ciphertext: string): string {
    try {
      return this.encryption.decrypt(ciphertext, apiKeyAad(id));
    } catch (error) {
      // A key whose secret cannot be decrypted is a key nobody can use, and the reason is ours
      // (a rotated master key, a hand-edited row) rather than the caller's. Said as a 500 with a
      // logged cause, never as "wrong signature", which would send an integrator hunting for a bug
      // they do not have.
      this.logger.error({ err: error, apiKeyId: id }, 'an API key secret could not be decrypted');
      throw new AppError(
        'INTERNAL_ERROR',
        'That key cannot be used at the moment. Rotate it, or contact the business.',
        500,
      );
    }
  }

  private async assertWithinRate(keyRowId: string, perMinute: number): Promise<void> {
    // A fixed window per minute, keyed by the minute itself: a sliding window on a public write
    // endpoint is a sorted set per key, and the fixed one is what the auth throttle already uses.
    const key = this.redis.key(null, 'ingest', 'rate', keyRowId, Math.floor(Date.now() / 60_000));
    try {
      const count = await this.redis.increment(key, 120);
      if (count > perMinute) {
        throw new AppError(
          'RATE_LIMITED',
          `That key is limited to ${perMinute} requests a minute. Retry shortly — nothing was lost.`,
          429,
          { retryAfterSeconds: 60 },
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Fails closed, like the login and form throttles: an unlimited public write endpoint is the
      // worse outcome when Redis is unavailable.
      this.logger.error({ err: error }, 'the ingestion rate limiter is unavailable');
      throw new AppError(
        'RATE_LIMITED',
        'Ingestion is temporarily unavailable. Retry shortly.',
        429,
      );
    }
  }

  private async recordUse(keyRowId: string, ip: string | undefined): Promise<void> {
    await withPlatformScope('public ingestion: record that a key was used', async () => {
      await this.db.client.apiKey.updateMany({
        where: { id: keyRowId },
        data: { lastUsedAt: new Date(), lastUsedIp: ip ?? null },
      });
    });
  }

  private badKey(message: string): AppError {
    return new AppError('INVALID_API_KEY', message, 401);
  }

  /** Why a signature was refused, in words an integrator can act on. */
  static signatureMessage(failure: SignatureFailure): string {
    switch (failure) {
      case 'missing':
        return 'This endpoint requires a signature. Send X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">.';
      case 'malformed':
        return 'The X-Signature header is not in the documented form: t=<unix seconds>,v1=<64 hex characters>.';
      case 'stale':
        return 'That signature is outside the five-minute window. Check the clock on the sending machine.';
      default:
        return 'The signature did not match the body. Sign the exact bytes you send, with this key’s secret.';
    }
  }
}

/**
 * Whether an address is inside a CIDR range, or equal to a bare address.
 *
 * IPv4 is computed; an IPv6 range is matched **exactly** rather than guessed at, because a
 * half-right CIDR implementation on a security boundary is worse than one that refuses what it
 * cannot be sure of. Exported so the suite can test it without a request.
 */
export function matchesCidr(entry: string, ip: string): boolean {
  if (!entry.includes('/')) return entry === ip;
  const [range, bitsText] = entry.split('/');
  const bits = Number(bitsText);
  if (!range || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const a = toInt(range);
  const b = toInt(ip);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}

function toInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let total = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    total = total * 256 + octet;
  }
  return total >>> 0;
}
