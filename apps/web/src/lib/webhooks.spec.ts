import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_DELIVERY_STATUSES as SHARED_STATUSES,
  WEBHOOK_EVENT_TYPES as SHARED_TYPES,
  WEBHOOK_TEST_EVENT as SHARED_TEST_EVENT,
} from '@leados/shared';
import {
  DELIVERY_STATUS_CLASSES,
  DELIVERY_STATUS_LABELS,
  EVENT_GROUPS,
  EVENT_LABELS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_TEST_EVENT,
  describeDelivery,
  describeEndpointActivity,
  describeWebhooks,
  endpointStanding,
  relativeInFuture,
  verificationSnippet,
  type WebhookDeliveryRow,
  type WebhookEndpointRecord,
} from './webhooks';

/**
 * The reconciliation this file exists for.
 *
 * `lib/webhooks.ts` hand-writes the event catalogue because `@leados/shared`'s entry point reaches
 * `node:async_hooks` and a client component that imports it fails `next build`. A spec runs in Node
 * and may import both: an event this screen offers that the API refuses cannot be saved, and one
 * the API fans out that this screen omits is an event nobody can subscribe to.
 */
describe('the event catalogue matches the API', () => {
  it('offers exactly the events the product emits', () => {
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([...SHARED_TYPES]);
    expect([...WEBHOOK_DELIVERY_STATUSES]).toEqual([...SHARED_STATUSES]);
    expect(WEBHOOK_TEST_EVENT).toBe(SHARED_TEST_EVENT);
  });

  it('has a sentence for every event, so no tick box is a bare schema name', () => {
    for (const type of SHARED_TYPES) {
      expect(EVENT_LABELS[type], type).toBeTruthy();
      expect(EVENT_LABELS[type], type).not.toBe(type);
    }
  });

  it('has a label and a colour for every delivery status', () => {
    for (const status of SHARED_STATUSES) {
      expect(DELIVERY_STATUS_LABELS[status]).toBeTruthy();
      expect(DELIVERY_STATUS_CLASSES[status]).toBeTruthy();
    }
  });

  it('puts every event in a group, so none is invisible on the picker', () => {
    // A type whose prefix matches no group would simply not render — the quietest possible way to
    // lose a feature.
    for (const type of SHARED_TYPES) {
      expect(
        EVENT_GROUPS.some((group) => type.startsWith(group.prefix)),
        type,
      ).toBe(true);
    }
  });
});

function endpoint(overrides: Partial<WebhookEndpointRecord> = {}): WebhookEndpointRecord {
  return {
    id: 'e1',
    url: 'https://hooks.example.com/leados',
    description: null,
    eventTypes: ['lead.created'],
    isActive: true,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastStatusCode: null,
    disabledAt: null,
    disabledReason: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('endpointStanding', () => {
  it('reads a healthy endpoint as live', () => {
    expect(endpointStanding(endpoint())).toEqual({ label: 'Live', tone: 'success' });
  });

  it('warns while an endpoint is failing but still being tried', () => {
    const standing = endpointStanding(endpoint({ failureCount: 3 }));
    expect(standing.tone).toBe('warning');
    expect(standing.label).toContain('3 failing');
  });

  it('separates "we stopped" from "you switched it off"', () => {
    // The first is a broken integration and the second is a decision; one chip for both would hide
    // the only one that needs attention.
    const auto = endpointStanding(
      endpoint({
        isActive: false,
        disabledAt: 'x',
        disabledReason: '15 deliveries failed in a row',
      }),
    );
    expect(auto).toEqual({ label: 'Stopped by us', tone: 'danger' });
    const manual = endpointStanding(
      endpoint({
        isActive: false,
        disabledAt: 'x',
        disabledReason: 'Switched off by the workspace',
      }),
    );
    expect(manual.tone).toBe('neutral');
  });
});

describe('describeEndpointActivity', () => {
  const now = new Date('2026-10-14T10:00:00.000Z');

  it('says plainly that nothing has been sent yet', () => {
    expect(describeEndpointActivity(endpoint(), now)).toContain('Nothing has been sent');
  });

  it('reports the last delivery', () => {
    expect(
      describeEndpointActivity(endpoint({ lastSuccessAt: '2026-10-14T09:56:00.000Z' }), now),
    ).toBe('Last delivered 4 minutes ago.');
  });

  it('names the failure and its status code, which is what a developer needs', () => {
    const sentence = describeEndpointActivity(
      endpoint({ lastFailureAt: '2026-10-14T09:30:00.000Z', lastStatusCode: 500 }),
      now,
    );
    expect(sentence).toBe('Never delivered — last failed 30 minutes ago (HTTP 500).');
  });

  it('says "no answer" rather than inventing a status code', () => {
    const sentence = describeEndpointActivity(
      endpoint({ lastFailureAt: '2026-10-14T09:30:00.000Z', lastStatusCode: null }),
      now,
    );
    expect(sentence).toContain('no answer');
  });

  it('reports both when an endpoint is flaky', () => {
    const sentence = describeEndpointActivity(
      endpoint({
        lastSuccessAt: '2026-10-14T09:50:00.000Z',
        lastFailureAt: '2026-10-14T09:55:00.000Z',
        lastStatusCode: 503,
      }),
      now,
    );
    expect(sentence).toBe('Last delivered 10 minutes ago, last failed 5 minutes ago (HTTP 503).');
  });
});

function delivery(overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow {
  return {
    id: 'd1',
    endpoint: null,
    eventId: 'evt',
    eventType: 'lead.created',
    status: 'succeeded',
    attemptCount: 1,
    nextAttemptAt: null,
    lastStatusCode: 200,
    lastResponseBody: null,
    lastError: null,
    deliveredAt: '2026-10-14T09:59:00.000Z',
    createdAt: '2026-10-14T09:59:00.000Z',
    payload: null,
    attempts: [],
    ...overrides,
  };
}

describe('describeDelivery', () => {
  const now = new Date('2026-10-14T10:00:00.000Z');

  it('counts to one', () => {
    expect(describeDelivery(delivery(), now)).toBe('1 attempt · HTTP 200');
    expect(describeDelivery(delivery({ attemptCount: 3 }), now)).toBe('3 attempts · HTTP 200');
  });

  it('says when the next attempt is due, because that is the question', () => {
    const sentence = describeDelivery(
      delivery({
        status: 'failed',
        attemptCount: 2,
        lastStatusCode: 500,
        nextAttemptAt: '2026-10-14T10:05:00.000Z',
      }),
      now,
    );
    expect(sentence).toBe('2 attempts · HTTP 500 · trying again in 5 minutes');
  });

  it('prefers the error to a status code that does not exist', () => {
    const sentence = describeDelivery(
      delivery({
        status: 'exhausted',
        attemptCount: 8,
        lastStatusCode: null,
        lastError: 'No answer within 10 seconds.',
      }),
      now,
    );
    expect(sentence).toBe('8 attempts · No answer within 10 seconds.');
  });

  it('says a queued delivery has not been tried', () => {
    expect(describeDelivery(delivery({ status: 'pending', attemptCount: 0 }), now)).toBe(
      'Queued, not attempted yet',
    );
  });
});

describe('relativeInFuture', () => {
  const now = new Date('2026-10-14T10:00:00.000Z');

  it('reads as any moment now when the retry is already due', () => {
    expect(relativeInFuture('2026-10-14T09:59:00.000Z', now)).toBe('any moment now');
    expect(relativeInFuture('2026-10-14T10:00:00.000Z', now)).toBe('any moment now');
  });

  it('counts to one in every unit', () => {
    expect(relativeInFuture('2026-10-14T10:01:00.000Z', now)).toBe('in 1 minute');
    expect(relativeInFuture('2026-10-14T11:00:00.000Z', now)).toBe('in 1 hour');
    expect(relativeInFuture('2026-10-15T10:00:00.000Z', now)).toBe('in 1 day');
    expect(relativeInFuture('2026-10-14T12:00:00.000Z', now)).toBe('in 2 hours');
  });
});

describe('describeWebhooks', () => {
  it('tells an empty workspace what an endpoint is for', () => {
    expect(describeWebhooks({ endpoints: 0, live: 0, failing: 0 })).toContain(
      'post every event you choose',
    );
  });

  it('omits what is zero and counts to one', () => {
    expect(describeWebhooks({ endpoints: 1, live: 1, failing: 0 })).toBe('1 endpoint · 1 live.');
    expect(describeWebhooks({ endpoints: 3, live: 2, failing: 1 })).toBe(
      '3 endpoints · 2 live · 1 we have stopped sending to.',
    );
  });
});

describe('verificationSnippet', () => {
  const snippet = verificationSnippet();

  it('hashes the timestamp and the raw body, which is what the sender signs', () => {
    expect(snippet).toContain('${timestamp}.${request.rawBody}');
    expect(snippet).toContain("createHmac('sha256', SECRET)");
  });

  it('compares in constant time, because a fast comparison leaks the answer', () => {
    expect(snippet).toContain('timingSafeEqual');
  });

  it('tells the reader to deduplicate, because delivery is at-least-once', () => {
    expect(snippet).toContain('x-leados-event-id');
    expect(snippet.toLowerCase()).toContain('at-least-once');
  });

  it('never contains a secret', () => {
    expect(snippet).not.toMatch(/whsec_[A-Za-z0-9]{6,}/);
    expect(snippet).toContain('process.env.LEADOS_WEBHOOK_SECRET');
  });
});
