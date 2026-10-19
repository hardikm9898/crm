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

  seal(connectionId: string, plaintext: string): string {
    return this.encryption.encrypt(plaintext, integrationAad(connectionId));
  }

  open(connectionId: string, envelope: string): string {
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
