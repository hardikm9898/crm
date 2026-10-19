import { describe, expect, it } from 'vitest';
import { COMMON_ERROR_STATUSES, ERROR_CATALOGUE, errorCatalogueEntries } from './index.js';

/**
 * The catalogue is a `Record<ErrorCode, …>`, so "every code is described" is a compile-time fact
 * rather than a test. What a test can add is that each description is usable: a status that
 * matches the code's family, advice that is not a shrug, and a retry rule that agrees with the
 * status — a 429 a client does not retry is a client that drops work.
 */
describe('the published error catalogue', () => {
  it('describes every code with a status, a meaning and a next step', () => {
    for (const entry of errorCatalogueEntries()) {
      expect(entry.status, entry.code).toBeGreaterThanOrEqual(400);
      expect(entry.status, entry.code).toBeLessThan(600);
      expect(entry.meaning.length, entry.code).toBeGreaterThan(20);
      expect(entry.whatToDo.length, entry.code).toBeGreaterThan(20);
      // "Contact support" as the only advice is what this catalogue exists to avoid.
      expect(entry.whatToDo, entry.code).not.toMatch(/^contact support\.?$/i);
    }
  });

  it('agrees with itself about retrying', () => {
    expect(ERROR_CATALOGUE.RATE_LIMITED.retry).toBe('with-backoff');
    expect(ERROR_CATALOGUE.INTERNAL_ERROR.retry).toBe('with-backoff');
    // A quota is a business condition: retrying is how a client spins.
    expect(ERROR_CATALOGUE.LIMIT_EXCEEDED.retry).toBe('never');
    expect(ERROR_CATALOGUE.VALIDATION_FAILED.retry).toBe('after-fixing');
    for (const entry of errorCatalogueEntries()) {
      if (entry.status >= 500) expect(entry.retry, entry.code).toBe('with-backoff');
      // A 403 is never a timing problem.
      if (entry.status === 403) expect(entry.retry, entry.code).toBe('never');
    }
  });

  it('keeps LIMIT_EXCEEDED and RATE_LIMITED distinguishable, which is the point of having both', () => {
    expect(ERROR_CATALOGUE.LIMIT_EXCEEDED.status).toBe(403);
    expect(ERROR_CATALOGUE.RATE_LIMITED.status).toBe(429);
  });

  it('sorts the page by status, then by name', () => {
    const entries = errorCatalogueEntries();
    for (let i = 1; i < entries.length; i += 1) {
      const previous = entries[i - 1]!;
      const current = entries[i]!;
      expect(
        previous.status < current.status ||
          (previous.status === current.status && previous.code < current.code),
      ).toBe(true);
    }
  });

  it('lists only statuses the catalogue actually describes as common', () => {
    const described = new Set(errorCatalogueEntries().map((entry) => entry.status));
    for (const status of COMMON_ERROR_STATUSES)
      expect(described.has(status), String(status)).toBe(true);
  });
});
