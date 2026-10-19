import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  credentialMessage,
  parseApiCredential,
  restPermissionsOf,
  withPlatformScope,
  type DataScope,
  type ParsedCredential,
  type TenantPrincipal,
} from '@leados/shared';
import { timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { EncryptionService } from '../../infra/crypto/encryption.service.js';
import { RedisService } from '../../infra/redis/redis.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { PrincipalService } from '../auth/application/principal.service.js';
import { DEFAULT_RATE_LIMIT_PER_MIN, apiKeyAad, matchesCidr } from '../ingestion/ingest-auth.service.js';

/** What the guard needs back: the principal to run as, and the key it belongs to for the log. */
export interface AuthenticatedKey {
  readonly principal: TenantPrincipal;
  readonly apiKeyRowId: string;
  readonly keyId: string;
}

/**
 * Who is calling the authenticated REST surface with a key, and what may they do (`FR-API-1`).
 *
 * **A key acts as the member who created it, narrowed to its scopes.** That is the decision this
 * file exists to make, and the alternatives are both worse:
 *
 *  * Giving a key its scopes at organization-wide scope would let a branch manager mint a
 *    credential that reads the whole workspace — an escalation performed with a button.
 *  * Freezing the creator's grants into the row at creation time would leave a key working with
 *    permissions its creator lost months ago, which is the same escalation with a delay.
 *
 * So the creator's **current** grants are resolved on every request through `PrincipalService` —
 * the same path the import and export processors already take, and for the same reason — and the
 * key's permission set is the intersection of those grants with its own scopes, each at the scope
 * the creator holds. Revoke the person's role and the key narrows with it; deactivate them and the
 * key stops working, saying so.
 *
 * The order of the checks mirrors the public endpoint's, because the reasoning is identical
 * (`IngestAuthService`): identity, then address, then standing, then the rate limit, and the
 * credential's secret **last** — so grinding secrets costs an attacker requests.
 */
@Injectable()
export class ApiKeyAuthService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly encryption: EncryptionService,
    private readonly principals: PrincipalService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async authenticate(input: {
    authorization: string | undefined;
    ip: string | undefined;
    requestId: string;
    /**
     * Called the moment the key — and therefore the workspace — is known, before any of the
     * checks that can still refuse it.
     *
     * The refusals an integrator most needs to see are exactly these: an address off the
     * allowlist, a rate limit, a secret that does not match, a scope the key does not hold. Marking
     * the request only on success would leave all four out of the log that exists to explain them.
     */
    identify?: (mark: { organizationId: string; apiKeyId: string }) => void;
  }): Promise<AuthenticatedKey> {
    const parsed = parseApiCredential(input.authorization);
    if (!parsed.ok) throw new AppError('INVALID_API_KEY', credentialMessage(parsed.failure), 401);

    const key = await this.findKey(parsed.credential);
    input.identify?.({ organizationId: key.organizationId, apiKeyId: key.id });

    if (!this.addressAllowed(key.ipAllowlist, input.ip)) {
      throw new AppError(
        'FORBIDDEN',
        'This key only accepts requests from the addresses on its allowlist, and this request did not come from one.',
        403,
      );
    }

    await this.assertWithinRate(key.id, key.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN);
    this.assertSecretMatches(key, parsed.credential.secret);

    const principal = await this.buildPrincipal(key, input.requestId);
    // After the credential is accepted, and never inside a caller's transaction: "is this key
    // still in use" has to be answerable before somebody revokes it.
    await this.recordUse(key.id, input.ip);

    return { principal, apiKeyRowId: key.id, keyId: key.keyId };
  }

  /** Whether a request from `ip` is allowed by a key's allowlist. An empty list allows everything. */
  addressAllowed(allowlist: readonly string[], ip: string | undefined): boolean {
    if (allowlist.length === 0) return true;
    if (!ip) return false;
    return allowlist.some((entry) => matchesCidr(entry, ip));
  }

  private async findKey(credential: ParsedCredential) {
    // Across tenants, because the key id is the only thing that says which workspace this is.
    const key = await withPlatformScope('REST surface: resolve the API key', async () =>
      this.db.client.apiKey.findFirst({
        where: { keyId: credential.keyId },
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
          createdById: true,
        },
      }),
    );

    if (
      !key ||
      key.revokedAt !== null ||
      (key.expiresAt !== null && key.expiresAt <= new Date())
    ) {
      // One indistinguishable answer for unknown, revoked and expired: the shape of the refusal
      // must not say which of the three it was.
      throw new AppError('INVALID_API_KEY', 'That API key is not valid.', 401);
    }
    return key;
  }

  private assertSecretMatches(key: { id: string; secretEncrypted: string }, presented: string): void {
    const stored = this.decryptSecret(key.id, key.secretEncrypted);
    const a = Buffer.from(stored);
    const b = Buffer.from(presented);
    // Length first, because `timingSafeEqual` throws on a mismatch rather than answering false —
    // and a thrown comparison would become a 500 where the honest answer is 401.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError(
        'INVALID_API_KEY',
        'That key id and secret do not go together. Send both halves of the credential you were given.',
        401,
      );
    }
  }

  private decryptSecret(id: string, ciphertext: string): string {
    try {
      return this.encryption.decrypt(ciphertext, apiKeyAad(id));
    } catch (error) {
      // Ours, not the caller's: a rotated master key or a hand-edited row. Said as a 500 with a
      // logged cause rather than as "wrong secret", which would send an integrator hunting for a
      // bug they do not have.
      this.logger.error({ err: error, apiKeyId: id }, 'an API key secret could not be decrypted');
      throw new AppError(
        'INTERNAL_ERROR',
        'That key cannot be used at the moment. Rotate it, or contact the business.',
        500,
      );
    }
  }

  /**
   * The key's principal: its creator's current grants, narrowed to the key's scopes.
   *
   * `PrincipalService.build` also does the standing checks — the membership is active, the
   * workspace is usable — so a key whose creator has left, or whose workspace is suspended, is
   * refused here with the reason that is actually true.
   */
  private async buildPrincipal(
    key: { id: string; organizationId: string; scopes: string[]; createdById: string | null },
    requestId: string,
  ): Promise<TenantPrincipal> {
    const granted = restPermissionsOf(key.scopes);
    if (granted.length === 0) {
      throw new AppError(
        'PERMISSION_DENIED',
        'This key has no scopes for the REST API. Give it the ones your integration needs — it can still post leads to the public endpoint.',
        403,
      );
    }

    if (!key.createdById) {
      // Every key created through the API has a creator; a row written by a fixture or a migration
      // might not, and a key that acts as nobody would have to be given a scope by this code.
      throw new AppError(
        'PERMISSION_DENIED',
        'This key is not attached to a member of the workspace, so there is nobody for it to act as. Create a new one.',
        403,
      );
    }

    const creator = await this.creatorPrincipal(key, requestId);
    const permissions = new Set<string>();
    const scopes = new Map<string, DataScope>();
    for (const permission of granted) {
      if (!creator.permissions.has(permission)) continue;
      permissions.add(permission);
      scopes.set(permission, creator.scopes.get(permission) ?? 'own');
    }

    if (permissions.size === 0) {
      throw new AppError(
        'PERMISSION_DENIED',
        'The member who created this key no longer holds the permissions it was given. Create a new key, or restore their access.',
        403,
      );
    }

    return {
      organizationId: key.organizationId,
      // `actorType` says a credential did this; `actorId` is the **person** it acts as, and
      // `apiKeyId` is which credential. The person has to be the actor because every
      // person-reference in this product is written from `actorId` — `created_by_id`,
      // `changed_by_id`, `assigned_by_id`, a saved view's owner — and a key's own id in one of
      // those columns is a row claiming a member who does not exist. Nothing enforces it: some of
      // those columns have a composite FK into `Membership` and some have none at all, so the
      // first version of this file wrote three such leads and no constraint objected.
      actorType: 'api_key',
      actorId: key.createdById,
      apiKeyId: key.id,
      permissions,
      scopes,
      // Inherited, because a data scope of `team` means nothing without the teams it refers to.
      teamIds: creator.teamIds,
      branchIds: creator.branchIds,
      requestId,
    };
  }

  private async creatorPrincipal(
    key: { organizationId: string; createdById: string | null },
    requestId: string,
  ): Promise<TenantPrincipal> {
    try {
      return await this.principals.build({
        userId: key.createdById as string,
        organizationId: key.organizationId,
        // There is no session behind a key. The request id stands in, which is also what the
        // system principal does for a sweep.
        sessionId: requestId,
        requestId,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'FORBIDDEN') {
        throw new AppError(
          'PERMISSION_DENIED',
          'The member who created this key is no longer active in this workspace, so the key cannot act for them. Create a new one.',
          403,
        );
      }
      throw error;
    }
  }

  private async assertWithinRate(keyRowId: string, perMinute: number): Promise<void> {
    // The same fixed window per minute the public endpoint uses, under its own name so a key's
    // REST traffic and its ingestion traffic are not counted against one allowance: an integration
    // that posts leads should not be throttled by its own dashboard polling.
    const key = this.redis.key(null, 'api', 'rate', keyRowId, Math.floor(Date.now() / 60_000));
    try {
      const count = await this.redis.increment(key, 120);
      if (count > perMinute) {
        throw new AppError(
          'RATE_LIMITED',
          `That key is limited to ${perMinute} requests a minute. Retry shortly.`,
          429,
          { retryAfterSeconds: 60 },
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Fails closed, like every other limiter in this product: an unlimited authenticated surface
      // is the worse outcome when Redis is unavailable.
      this.logger.error({ err: error }, 'the API key rate limiter is unavailable');
      throw new AppError('RATE_LIMITED', 'The API is temporarily unavailable. Retry shortly.', 429);
    }
  }

  private async recordUse(keyRowId: string, ip: string | undefined): Promise<void> {
    await withPlatformScope('REST surface: record that a key was used', async () => {
      await this.db.client.apiKey.updateMany({
        where: { id: keyRowId },
        data: { lastUsedAt: new Date(), lastUsedIp: ip ?? null },
      });
    });
  }
}
