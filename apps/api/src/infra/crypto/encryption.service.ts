import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';

/**
 * AES-256-GCM encryption for secrets that must be readable again: TOTP secrets today,
 * integration credentials (Meta tokens, ad accounts, payment keys) from Phase 4
 * (docs/integration-architecture.md §5).
 *
 * Design points that matter:
 *  • **AAD binds ciphertext to its context.** A blob encrypted for user A's MFA secret
 *    cannot be pasted into user B's row and decrypted — the auth tag check fails.
 *  • **Key version is stored with the ciphertext**, so rotation is a background
 *    re-encrypt rather than a breaking change.
 *  • Plaintext is never logged and never returned by an endpoint.
 *
 * Envelope encryption with per-organization data keys (as documented) is the Phase 4
 * extension; the wire format below already carries the version field it needs.
 */
const FORMAT_VERSION = 'v1';
const IV_LENGTH = 12; // 96-bit nonce, the GCM recommendation
const KEY_LENGTH = 32;

export class DecryptionError extends Error {
  constructor(reason: string) {
    // Deliberately vague: a decryption failure must not describe which part failed.
    super(`Unable to decrypt value (${reason})`);
    this.name = 'DecryptionError';
  }
}

@Injectable()
export class EncryptionService {
  private readonly masterKey: Buffer;
  private readonly keyVersion = 1;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.masterKey = Buffer.from(config.ENCRYPTION_MASTER_KEY, 'base64');
    if (this.masterKey.length !== KEY_LENGTH) {
      throw new Error(`ENCRYPTION_MASTER_KEY must decode to ${KEY_LENGTH} bytes`);
    }
  }

  /**
   * @param plaintext The secret.
   * @param aad Additional authenticated data identifying where this ciphertext belongs,
   *            e.g. `mfa:{userId}`. It is not secret, but it is tamper-evident.
   */
  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      FORMAT_VERSION,
      this.keyVersion,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string, aad: string): string {
    const parts = payload.split('.');
    if (parts.length !== 5) throw new DecryptionError('malformed payload');
    const [format, , ivPart, tagPart, ciphertextPart] = parts;
    if (format !== FORMAT_VERSION) throw new DecryptionError('unsupported format');

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.masterKey,
        Buffer.from(ivPart!, 'base64url'),
        { authTagLength: 16 },
      );
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagPart!, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart!, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key, wrong context, or tampered ciphertext — all indistinguishable to callers.
      throw new DecryptionError('authentication failed');
    }
  }

  /** Constant-time comparison for secrets and signatures. */
  static safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
