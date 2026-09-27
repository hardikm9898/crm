import { describe, expect, it } from 'vitest';
import { DecryptionError, EncryptionService } from './encryption.service.js';
import type { AppConfig } from '../config/config.schema.js';

const key = Buffer.alloc(32, 7).toString('base64');
const otherKey = Buffer.alloc(32, 9).toString('base64');
const service = new EncryptionService({ ENCRYPTION_MASTER_KEY: key } as AppConfig);

describe('EncryptionService', () => {
  it('round-trips a secret', () => {
    const payload = service.encrypt('JBSWY3DPEHPK3PXP', 'mfa:user-1');
    expect(service.decrypt(payload, 'mfa:user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never stores the plaintext in the payload', () => {
    const payload = service.encrypt('super-secret-value', 'mfa:user-1');
    expect(payload).not.toContain('super-secret-value');
    expect(payload.startsWith('v1.1.')).toBe(true);
  });

  it('uses a fresh nonce, so identical plaintexts differ', () => {
    const a = service.encrypt('same', 'mfa:user-1');
    const b = service.encrypt('same', 'mfa:user-1');
    expect(a).not.toBe(b);
  });

  it('binds ciphertext to its context: another user cannot reuse the blob', () => {
    // This is the property that stops a stolen row being replayed into a different record.
    const payload = service.encrypt('JBSWY3DPEHPK3PXP', 'mfa:user-1');
    expect(() => service.decrypt(payload, 'mfa:user-2')).toThrow(DecryptionError);
  });

  it('detects tampering', () => {
    const payload = service.encrypt('value', 'mfa:user-1');
    const parts = payload.split('.');
    const flipped = Buffer.from(parts[4]!, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[4] = flipped.toString('base64url');
    expect(() => service.decrypt(parts.join('.'), 'mfa:user-1')).toThrow(DecryptionError);
  });

  it('cannot be decrypted with a different master key', () => {
    const other = new EncryptionService({ ENCRYPTION_MASTER_KEY: otherKey } as AppConfig);
    const payload = service.encrypt('value', 'mfa:user-1');
    expect(() => other.decrypt(payload, 'mfa:user-1')).toThrow(DecryptionError);
  });

  it('rejects malformed payloads without leaking which part failed', () => {
    expect(() => service.decrypt('nonsense', 'aad')).toThrow(/Unable to decrypt/);
    expect(() => service.decrypt('v1.1.a.b', 'aad')).toThrow(/Unable to decrypt/);
    expect(() => service.decrypt('v9.1.a.b.c', 'aad')).toThrow(/unsupported format/);
  });

  it('refuses a master key of the wrong length at construction', () => {
    expect(
      () =>
        new EncryptionService({
          ENCRYPTION_MASTER_KEY: Buffer.alloc(16).toString('base64'),
        } as AppConfig),
    ).toThrow(/32 bytes/);
  });

  it('compares secrets in constant time', () => {
    expect(EncryptionService.safeEqual('abc', 'abc')).toBe(true);
    expect(EncryptionService.safeEqual('abc', 'abd')).toBe(false);
    expect(EncryptionService.safeEqual('abc', 'abcd')).toBe(false);
  });
});
