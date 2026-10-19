import { describe, expect, it } from 'vitest';
import { breakingOnly, describeChanges, diffDocuments } from './breaking-changes.js';

/**
 * The classifier is what makes the committed document a **check** rather than a file that changes
 * on every commit, so the cases that matter are the ones where "the diff is small" and "the change
 * is safe" come apart.
 */
function document(operations: Record<string, Record<string, unknown>>) {
  return { paths: operations } as Record<string, unknown>;
}

function operation(over: Record<string, unknown> = {}) {
  return {
    operationId: 'Leads_list',
    'x-leados-permission': 'lead:read',
    responses: { '200': {} },
    ...over,
  };
}

function body(required: string[], properties: string[] = required) {
  return {
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: Object.fromEntries(properties.map((name) => [name, { type: 'string' }])),
            required,
          },
        },
      },
    },
  };
}

describe('what breaks a client', () => {
  it('says nothing changed when nothing did', () => {
    const before = document({ '/api/v1/leads': { get: operation() } });
    expect(diffDocuments(before, structuredClone(before))).toEqual([]);
    expect(describeChanges([])).toMatch(/unchanged/);
  });

  it('calls a removed path or operation breaking', () => {
    const before = document({ '/api/v1/leads': { get: operation(), post: operation() } });
    const afterPathGone = document({});
    expect(breakingOnly(diffDocuments(before, afterPathGone))).toHaveLength(1);

    const afterPostGone = document({ '/api/v1/leads': { get: operation() } });
    const changes = breakingOnly(diffDocuments(before, afterPostGone));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.where).toBe('POST /api/v1/leads');
  });

  it('calls a new path or operation additive', () => {
    const before = document({ '/api/v1/leads': { get: operation() } });
    const after = document({
      '/api/v1/leads': { get: operation(), post: operation() },
      '/api/v1/deals': { get: operation() },
    });
    const changes = diffDocuments(before, after);
    expect(breakingOnly(changes)).toEqual([]);
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.kind === 'additive')).toBe(true);
  });

  it('calls a changed permission breaking — including for every key whose scopes name the old one', () => {
    const before = document({ '/api/v1/leads': { get: operation() } });
    const after = document({
      '/api/v1/leads': { get: operation({ 'x-leados-permission': 'lead:update' }) },
    });
    const changes = breakingOnly(diffDocuments(before, after));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.what).toMatch(/lead:read to lead:update/);
  });

  it('calls a newly required plan feature breaking, and dropping one additive', () => {
    const plain = document({ '/api/v1/leads': { get: operation() } });
    const gated = document({
      '/api/v1/leads': { get: operation({ 'x-leados-feature': 'advanced_reports' }) },
    });
    expect(breakingOnly(diffDocuments(plain, gated))).toHaveLength(1);
    // Removing the gate cannot break a caller who was already allowed through it.
    expect(breakingOnly(diffDocuments(gated, plain))).toEqual([]);
  });

  it('calls closing a route to API keys breaking', () => {
    const open = document({ '/api/v1/leads': { get: operation() } });
    const closed = document({
      '/api/v1/leads': { get: operation({ 'x-leados-session-only': true }) },
    });
    const changes = breakingOnly(diffDocuments(open, closed));
    expect(changes[0]?.what).toMatch(/API key can no longer/);
  });

  it('calls a newly required body field breaking, and a new optional one additive', () => {
    const before = document({ '/api/v1/leads': { post: operation(body([], ['firstName'])) } });
    const nowRequired = document({
      '/api/v1/leads': { post: operation(body(['firstName'])) },
    });
    expect(breakingOnly(diffDocuments(before, nowRequired))[0]?.what).toMatch(
      /firstName.*required/,
    );

    const extraOptional = document({
      '/api/v1/leads': { post: operation(body([], ['firstName', 'company'])) },
    });
    // An optional field nobody has to send is the commonest safe change there is.
    expect(diffDocuments(before, extraOptional)).toEqual([]);
  });

  it('distinguishes a new optional parameter from a new required one', () => {
    const before = document({ '/api/v1/leads': { get: operation() } });
    const optional = document({
      '/api/v1/leads': {
        get: operation({ parameters: [{ name: 'status', in: 'query', required: false }] }),
      },
    });
    expect(diffDocuments(before, optional).map((change) => change.kind)).toEqual(['additive']);

    const required = document({
      '/api/v1/leads': {
        get: operation({ parameters: [{ name: 'status', in: 'query', required: true }] }),
      },
    });
    expect(breakingOnly(diffDocuments(before, required))).toHaveLength(1);
  });

  it('calls an optional parameter becoming required breaking, and a removed one too', () => {
    const optional = document({
      '/api/v1/leads': {
        get: operation({ parameters: [{ name: 'status', in: 'query', required: false }] }),
      },
    });
    const required = document({
      '/api/v1/leads': {
        get: operation({ parameters: [{ name: 'status', in: 'query', required: true }] }),
      },
    });
    expect(breakingOnly(diffDocuments(optional, required))[0]?.what).toMatch(/became required/);
    // Removed: a client that relied on the filtering it did now gets the whole list.
    const none = document({ '/api/v1/leads': { get: operation({ parameters: [] }) } });
    expect(breakingOnly(diffDocuments(optional, none))[0]?.what).toMatch(/was removed/);
  });

  it('calls a success status that is no longer answered breaking', () => {
    const before = document({ '/api/v1/leads': { post: operation({ responses: { '201': {} } }) } });
    const after = document({ '/api/v1/leads': { post: operation({ responses: { '200': {} } }) } });
    const changes = breakingOnly(diffDocuments(before, after));
    expect(changes.some((change) => /no longer answers 201/.test(change.what))).toBe(true);
  });

  it('prints breaking changes first, with a mark a build log can be grepped for', () => {
    const before = document({ '/api/v1/leads': { get: operation(), post: operation() } });
    const after = document({ '/api/v1/deals': { get: operation() } });
    const message = describeChanges(diffDocuments(before, after));
    const lines = message.split('\n');
    expect(lines[0]).toMatch(/^ {2}✗/);
    expect(lines[lines.length - 1]).toMatch(/^ {2}\+/);
  });
});
