import { Inject, Injectable } from '@nestjs/common';
import { AppError, generateWebhookSecret } from '@leados/shared';
import type { Logger } from 'pino';
import { EncryptionService } from '../../infra/crypto/encryption.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';

/** The AAD binding a credential's ciphertext to its own connection row. */
export function integrationAad(connectionId: string): string {
  return `integration:${connectionId}`;
}

/**
 * The credential vault (Phase 4's "credential vault").
 *
 * It is one service rather than three `encryption.encrypt(...)` calls for one reason: **the AAD**.
 * Every secret in this product is bound to the row that owns it (`api_key:<id>`,
 * `webhook:<id>`, `mfa:<userId>`), so a ciphertext moved to another connection does not decrypt —
 * and a call site that passes the wrong id loses that guarantee silently, because the happy path
 * still works. Here there is one function that takes the connection's id and no way to pass
 * anything else.
 *
 * Two further rules it enforces rather than documents:
 *
 *  * **Plaintext never leaves.** `open` is callable only from inside this module's services; no
 *    presenter and no endpoint reads it. "I lost the token" is answered by reconnecting, which is
 *    also the honest answer to "it may have leaked".
 *  * **A credential that cannot be decrypted is ours, not the caller's.** A rotated master key or a
 *    hand-edited row answers 500 with the cause logged, never "the provider refused you" — which
 *    would send somebody to Postmark's support for a bug in our deployment. The same decision
 *    `IngestAuthService` made for an API key's secret.
 */
@Injectable()
export class IntegrationVaultService {
  constructor(
    private readonly encryption: EncryptionService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The version of the master key a new envelope is written under. */
  get keyVersion(): number {
    return this.encryption.currentKeyVersion;
  }

  /**
   * Seals a **set** of secrets as one envelope.
   *
   * One envelope rather than one per field, because the whole set is what a connection is: two
   * columns would make "the app secret was rotated and the page token was not" a state the schema
   * allowed and nothing checked, and the AAD would then have to distinguish them. The JSON inside
   * is never seen by anything but `open`.
   */
  seal(connectionId: string, secrets: Readonly<Record<string, string>>): string {
    return this.encryption.encrypt(JSON.stringify(secrets), integrationAad(connectionId));
  }

  /**
   * Opens the set.
   *
   * Envelopes written before this provider needed more than one secret hold a bare string rather
   * than JSON; `legacyKey` says which field such a value is. A parse that is attempted and caught
   * is the honest way to read two formats, and it costs one `try` on a path that already has one.
   */
  open(
    connectionId: string,
    envelope: string,
    legacyKey = 'credential',
  ): Readonly<Record<string, string>> {
    const plaintext = this.openRaw(connectionId, envelope);
    if (!plaintext.startsWith('{')) return { [legacyKey]: plaintext };
    try {
      const parsed = JSON.parse(plaintext) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { [legacyKey]: plaintext };
      }
      const secrets: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') secrets[key] = value;
      }
      return secrets;
    } catch {
      return { [legacyKey]: plaintext };
    }
  }

  private openRaw(connectionId: string, envelope: string): string {
    try {
      return this.encryption.decrypt(envelope, integrationAad(connectionId));
    } catch (error) {
      this.logger.error(
        { err: error, connectionId },
        'an integration credential could not be decrypted',
      );
      throw new AppError(
        'INTERNAL_ERROR',
        'That connection’s credential cannot be read at the moment. Reconnect it, or contact support.',
        500,
      );
    }
  }

  /**
   * The secret for an inbound connection, which **we** generate.
   *
   * `generateWebhookSecret` rather than a second generator: the sender signs with it exactly as an
   * outbound consumer verifies with its own, the construction is `signRequest`'s, and a
   * `whsec_`-prefixed secret is recognisable in somebody's config file as a Lead OS signing key.
   */
  generateSharedSecret(): string {
    return generateWebhookSecret();
  }
}
