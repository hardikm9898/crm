import { describe, expect, it } from 'vitest';
import {
  API_GRANTABLE_PERMISSIONS as SHARED_GRANTABLE,
  API_KEY_SCOPES as SHARED_SCOPES,
  INGESTION_SCOPES as SHARED_INGESTION,
  describeDuration as sharedDescribeDuration,
  statusClass as sharedStatusClass,
} from '@leados/shared';
import {
  API_GRANTABLE_PERMISSIONS,
  API_KEY_SCOPES,
  INGESTION_SCOPES,
  SCOPE_GROUPS,
  SCOPE_LABELS,
  describeApiActivity,
  describeDuration,
  describeKeyUsage,
  statusClass,
  type ApiLogSummary,
} from './api-surface';

/**
 * The web app hand-writes this vocabulary because it may not import `@leados/shared` at runtime
 * (the entry point reaches `node:async_hooks` and `next build` refuses it in a client component).
 * This spec is what makes that safe: it runs in Node, imports both, and fails the moment they
 * disagree — a scope the screen offers and the API refuses is a tick box that produces a 400.
 */
describe('the two copies of the scope vocabulary', () => {
  it('lists the same scopes, in the same order', () => {
    expect([...INGESTION_SCOPES]).toEqual([...SHARED_INGESTION]);
    expect([...API_GRANTABLE_PERMISSIONS]).toEqual([...SHARED_GRANTABLE]);
    expect([...API_KEY_SCOPES]).toEqual([...SHARED_SCOPES]);
  });

  it('labels every scope, and labels nothing that is not one', () => {
    for (const scope of API_KEY_SCOPES) {
      expect(SCOPE_LABELS[scope], scope).toBeTruthy();
      // The label is a sentence about what it does, not the key with its colon removed.
      expect(SCOPE_LABELS[scope]).not.toContain(':');
    }
    expect(Object.keys(SCOPE_LABELS).sort()).toEqual([...API_KEY_SCOPES].sort());
  });

  it('puts every scope in exactly one group', () => {
    const grouped = SCOPE_GROUPS.flatMap((group) => group.scopes);
    expect([...grouped].sort()).toEqual([...API_KEY_SCOPES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('classes a status and says a duration exactly as the API does', () => {
    for (const status of [200, 201, 304, 400, 401, 429, 500, 503, 100]) {
      expect(statusClass(status), String(status)).toBe(sharedStatusClass(status));
    }
    for (const ms of [0, 12, 999, 1000, 1400, 65_000]) {
      expect(describeDuration(ms), String(ms)).toBe(sharedDescribeDuration(ms));
    }
  });
});

function summary(over: Partial<ApiLogSummary> = {}): ApiLogSummary {
  return {
    requests: 0,
    succeeded: 0,
    refused: 0,
    failed: 0,
    averageDurationMs: null,
    slowestDurationMs: null,
    ...over,
  };
}

describe('the sentence above the log', () => {
  it('says what to do when nothing has arrived, rather than printing a nought', () => {
    const sentence = describeApiActivity(summary());
    expect(sentence).toMatch(/No requests in the last day/);
    expect(sentence).not.toMatch(/\b0\b/);
  });

  it('counts to one', () => {
    expect(describeApiActivity(summary({ requests: 1, succeeded: 1 }))).toMatch(/1 request /);
    expect(describeApiActivity(summary({ requests: 2, succeeded: 2 }))).toMatch(/2 requests /);
    // Every clause has its own plural, which is the bug `/today`'s summary shipped with.
    expect(describeApiActivity(summary({ requests: 3, failed: 1 }))).toMatch(/1 failure on our side/);
    expect(describeApiActivity(summary({ requests: 3, failed: 2 }))).toMatch(/2 failures on our side/);
  });

  it('omits what is zero and says so when everything worked', () => {
    const clean = describeApiActivity(summary({ requests: 5, succeeded: 5, averageDurationMs: 40 }));
    expect(clean).toMatch(/all answered/);
    expect(clean).toMatch(/40 ms on average/);
    expect(clean).not.toMatch(/refused/);
    expect(clean).not.toMatch(/failure/);
  });

  it('points at the refusals when there are any, and drops "all answered"', () => {
    const mixed = describeApiActivity(summary({ requests: 5, succeeded: 3, refused: 2 }));
    expect(mixed).toMatch(/2 refused — see why below/);
    expect(mixed).not.toMatch(/all answered/);
  });

  it('names the window when it is not a day', () => {
    expect(describeApiActivity(summary({ requests: 1 }), 6)).toMatch(/in the last 6 hours/);
  });
});

describe('what a key has been doing', () => {
  it('says nothing-yet rather than a zero, and counts refusals when there are any', () => {
    expect(describeKeyUsage(undefined)).toMatch(/No requests/);
    expect(describeKeyUsage({ apiKeyId: 'k', requests: 0, refused: 0, lastRequestAt: null })).toMatch(
      /No requests/,
    );
    expect(
      describeKeyUsage({ apiKeyId: 'k', requests: 1, refused: 0, lastRequestAt: null }),
    ).toBe('1 request in the last day.');
    expect(
      describeKeyUsage({ apiKeyId: 'k', requests: 9, refused: 4, lastRequestAt: null }),
    ).toBe('9 requests in the last day, 4 of them refused.');
  });
});
