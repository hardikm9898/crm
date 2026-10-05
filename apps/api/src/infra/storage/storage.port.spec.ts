import { describe, expect, it } from 'vitest';
import { assertSafeKey, documentKey, safeFileName, StorageKeyError } from './storage.port.js';

describe('storage keys', () => {
  it('refuses anything that could escape a root directory', () => {
    for (const key of ['../secrets', 'org/../../etc/passwd', 'a/./b', '/absolute', '']) {
      expect(() => assertSafeKey(key), key).toThrow(StorageKeyError);
    }
  });

  it('refuses a key carrying a null byte', () => {
    // A trailing null is how a path check gets bypassed in languages where the syscall truncates.
    expect(() => assertSafeKey('org/a\0b')).toThrow(StorageKeyError);
  });

  it('accepts an ordinary nested key', () => {
    expect(() => assertSafeKey('org/abc/import/2026-10/file.csv')).not.toThrow();
  });

  it('puts the tenant first, because that is the prefix an operator purges', () => {
    const key = documentKey({
      organizationId: '0192c0de-dead-7000-8000-000000000000',
      subject: 'import',
      documentId: 'doc-1',
      fileName: 'leads.csv',
      at: new Date('2026-10-05T00:00:00Z'),
    });
    expect(key).toBe('org/0192c0de-dead-7000-8000-000000000000/import/2026-10/doc-1-leads.csv');
  });

  it('never trusts an uploaded file name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('my leads (final).csv')).toBe('my-leads-final-.csv');
    expect(safeFileName('.hidden')).toBe('hidden');
    expect(safeFileName('')).toBe('file');
  });

  it('caps the stored name so the whole key stays inside a filesystem limit', () => {
    expect(safeFileName(`${'a'.repeat(400)}.csv`).length).toBeLessThanOrEqual(96);
  });

  it('builds a safe key even from a hostile name and subject', () => {
    const key = documentKey({
      organizationId: 'org-1',
      subject: '../export',
      documentId: 'doc-2',
      fileName: '../../../../etc/shadow',
      at: new Date('2026-01-31T00:00:00Z'),
    });
    expect(key).toBe('org/org-1/export/2026-01/doc-2-shadow');
    expect(() => assertSafeKey(key)).not.toThrow();
  });
});
