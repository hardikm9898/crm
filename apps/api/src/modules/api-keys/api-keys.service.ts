import { Injectable } from '@nestjs/common';
import {
  AppError,
  generateApiKey,
  newId,
  tenantContext,
  type ApiKeyScope,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { EncryptionService } from '../../infra/crypto/encryption.service.js';
import { apiKeyAad } from '../ingestion/ingest-auth.service.js';
import type { CreateApiKeyInput, ListApiKeysQuery, UpdateApiKeyInput } from './api-keys.dto.js';

/**
 * API keys, from the workspace's side (`FR-API-2`, `FR-CAP-7`).
 *
 * Three decisions, each of which the alternative gets wrong:
 *
 *  * **The secret is returned exactly once, by `create` and `rotate`.** No endpoint answers it
 *    again — not because it cannot be recovered (it is stored encrypted, because verifying an HMAC
 *    needs the shared secret) but because an endpoint that hands a credential back on request is
 *    one an attacker with a session can use. "I lost it" is answered by rotating, which is also
 *    the honest answer to "it may have leaked" (ADR-0030).
 *  * **Revoking is a timestamp, not a delete.** Every payload the key ever sent references it, and
 *    "which key sent this" has to stay answerable — which is also why the FK is `RESTRICT`.
 *  * **Rotation keeps the row.** A rotated key is the same key with a new secret: its usage history,
 *    its scopes and its allowlist survive, and only the credential changes. Replacing the row would
 *    make a rotation look like a revocation plus a new integration in every log.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
  ) {}

  async list(query: ListApiKeysQuery) {
    const rows = await this.db.client.apiKey.findMany({
      where:
        query.revoked === undefined
          ? {}
          : query.revoked
            ? { revokedAt: { not: null } }
            : { revokedAt: null },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    return { items: rows.map((row) => this.present(row)), pagination: null };
  }

  async findOne(id: string) {
    const row = await this.db.client.apiKey.findFirst({ where: { id } });
    if (!row) throw AppError.notFound('API key');
    return this.present(row);
  }

  /** Answers the pair **once**. Everything after this call can only see the public half. */
  async create(input: CreateApiKeyInput) {
    const principal = tenantContext.require('apiKeys.create');
    const generated = generateApiKey();
    const id = newId();

    await this.db.client.$transaction(async (tx) => {
      await tx.apiKey.create({
        data: {
          id,
          organizationId: principal.organizationId,
          name: input.name,
          keyId: generated.keyId,
          keyPrefix: generated.prefix,
          // AES-256-GCM with the key's own id as the AAD, so the ciphertext cannot be moved into
          // another key's row and decrypted there.
          secretEncrypted: this.encryption.encrypt(generated.secret, apiKeyAad(id)),
          scopes: input.scopes,
          ipAllowlist: input.ipAllowlist ?? [],
          rateLimitPerMin: input.rateLimitPerMin ?? null,
          expiresAt: input.expiresAt ?? null,
          createdById: principal.actorId ?? null,
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'api_key.created',
        resourceType: 'api_key',
        resourceId: id,
        // The prefix, never the secret: an audit log is read by more people than a secret should be.
        after: { name: input.name, keyPrefix: generated.prefix, scopes: input.scopes },
      });
    });

    return {
      ...(await this.findOne(id)),
      keyId: generated.keyId,
      // Said in the payload as well as in the message, because a client that stores this field is
      // the one case where "shown once" has to be unmistakable.
      secret: generated.secret,
      secretShownOnce: true,
    };
  }

  async update(id: string, input: UpdateApiKeyInput) {
    const existing = await this.db.client.apiKey.findFirst({ where: { id } });
    if (!existing) throw AppError.notFound('API key');
    if (existing.revokedAt !== null) {
      throw AppError.businessRule(
        'That key has been revoked. Create a new one — a revoked key cannot be brought back, which is the point of revoking it.',
      );
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.apiKey.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
          ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist } : {}),
          ...(input.rateLimitPerMin !== undefined
            ? { rateLimitPerMin: input.rateLimitPerMin }
            : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'api_key.updated',
        resourceType: 'api_key',
        resourceId: id,
        before: { scopes: existing.scopes, ipAllowlist: existing.ipAllowlist },
        after: input as Record<string, unknown>,
      });
    });
    return this.findOne(id);
  }

  /** A new secret for the same key. The old one stops working the moment this returns. */
  async rotate(id: string) {
    const existing = await this.db.client.apiKey.findFirst({ where: { id } });
    if (!existing) throw AppError.notFound('API key');
    if (existing.revokedAt !== null) {
      throw AppError.businessRule('That key has been revoked, so there is nothing to rotate.');
    }

    const generated = generateApiKey();
    await this.db.client.$transaction(async (tx) => {
      await tx.apiKey.update({
        where: { id },
        data: {
          // The id changes too: a rotated secret with the same public id would make an old log line
          // ambiguous about which credential was in use.
          keyId: generated.keyId,
          keyPrefix: generated.prefix,
          secretEncrypted: this.encryption.encrypt(generated.secret, apiKeyAad(id)),
        },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'api_key.rotated',
        resourceType: 'api_key',
        resourceId: id,
        before: { keyPrefix: existing.keyPrefix },
        after: { keyPrefix: generated.prefix },
      });
    });

    return {
      ...(await this.findOne(id)),
      keyId: generated.keyId,
      secret: generated.secret,
      secretShownOnce: true,
    };
  }

  async revoke(id: string) {
    const principal = tenantContext.require('apiKeys.revoke');
    const existing = await this.db.client.apiKey.findFirst({ where: { id } });
    if (!existing) throw AppError.notFound('API key');
    if (existing.revokedAt !== null) return this.findOne(id);

    await this.db.client.$transaction(async (tx) => {
      await tx.apiKey.update({
        where: { id },
        // Who and when together: `api_keys_revocation_is_accounted_for` refuses half of it.
        data: { revokedAt: new Date(), revokedBy: principal.actorId ?? null },
      });
      await this.audit.recordInTransaction(tx, {
        action: 'api_key.revoked',
        resourceType: 'api_key',
        resourceId: id,
        before: { name: existing.name, keyPrefix: existing.keyPrefix },
      });
    });
    return this.findOne(id);
  }

  private present(row: {
    id: string;
    name: string;
    keyId: string;
    keyPrefix: string;
    scopes: string[];
    ipAllowlist: string[];
    rateLimitPerMin: number | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    lastUsedIp: string | null;
    revokedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      name: row.name,
      // The prefix, not the whole id: a screen that prints the full id invites a screenshot of it.
      keyPrefix: row.keyPrefix,
      scopes: row.scopes as ApiKeyScope[],
      ipAllowlist: row.ipAllowlist,
      rateLimitPerMin: row.rateLimitPerMin,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      lastUsedIp: row.lastUsedIp,
      revokedAt: row.revokedAt,
      isLive: row.revokedAt === null && (row.expiresAt === null || row.expiresAt > new Date()),
      createdAt: row.createdAt,
    };
  }
}
