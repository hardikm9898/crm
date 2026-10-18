import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_SCHEDULE_SECONDS,
  URL_REFUSAL_MESSAGES,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_TEST_EVENT,
  buildWebhookPayload,
  classifyWebhookUrl,
  generateWebhookSecret,
  isBlockedAddress,
  isBlockedHost,
  isDeliveredStatus,
  isPermanentRejection,
  isWebhookEventType,
  nextAttemptAt,
  signWebhook,
  webhookHeaders,
} from './webhooks.js';
import { signaturePayload, verifySignature } from './ingestion.js';

describe('the event catalogue', () => {
  it('offers only events the product can actually emit', () => {
    // A tick box for an event nothing emits is an endpoint that looks healthy and receives
    // nothing. The names that §8 lists and this product does not emit are deliberately absent.
    expect(WEBHOOK_EVENT_TYPES).not.toContain('conversation.created' as never);
    expect(WEBHOOK_EVENT_TYPES).not.toContain('message.received' as never);
    expect(WEBHOOK_EVENT_TYPES).not.toContain('payment.completed' as never);
    expect(WEBHOOK_EVENT_TYPES).not.toContain('form.submitted' as never);
    expect(WEBHOOK_EVENT_TYPES).toContain('payment.received');
    expect(WEBHOOK_EVENT_TYPES).toContain('lead.created');
  });

  it('names every type as `aggregate.thing_that_happened`', () => {
    for (const type of WEBHOOK_EVENT_TYPES) expect(type).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it('has no duplicates, which would fan out twice to one endpoint', () => {
    expect(new Set(WEBHOOK_EVENT_TYPES).size).toBe(WEBHOOK_EVENT_TYPES.length);
  });

  it('keeps the test ping out of the subscribable list', () => {
    // An endpoint always receives its own test; subscribing to it would be meaningless.
    expect(isWebhookEventType(WEBHOOK_TEST_EVENT)).toBe(false);
  });

  it('writes `pending` first, because that is the state a delivery is created in', () => {
    expect(WEBHOOK_DELIVERY_STATUSES[0]).toBe('pending');
  });
});

describe('the signature', () => {
  it('is the same construction as the inbound one, so a client implements it once', () => {
    const secret = 'whsec_example';
    const body = '{"id":"evt_1"}';
    const timestamp = 1_759_000_000;
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    expect(signWebhook(secret, timestamp, body)).toBe(`v1=${digest}`);
    expect(signaturePayload(timestamp, body)).toBe(`${timestamp}.${body}`);
  });

  it('is verifiable by the inbound verifier, which is what a receiver will write', () => {
    const secret = generateWebhookSecret();
    const body = '{"a":1}';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(secret, timestamp, body);
    // A receiver reads `t` from the header rather than the signature, so the two are recombined
    // here exactly as somebody following the documentation would recombine them.
    const check = verifySignature(secret, `t=${timestamp},${signature}`, body);
    expect(check.ok).toBe(true);
  });

  it('changes when a single byte of the body changes', () => {
    const secret = 'whsec_example';
    expect(signWebhook(secret, 1, '{"a":1}')).not.toBe(signWebhook(secret, 1, '{"a":2}'));
  });

  it('is bound to the timestamp as well as the body', () => {
    const secret = 'whsec_example';
    expect(signWebhook(secret, 1, '{}')).not.toBe(signWebhook(secret, 2, '{}'));
  });
});

describe('generateWebhookSecret', () => {
  it('is prefixed, so a leaked one is recognisable', () => {
    expect(generateWebhookSecret().startsWith('whsec_')).toBe(true);
  });

  it('is not guessable from another', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateWebhookSecret()));
    expect(secrets.size).toBe(50);
    expect([...secrets][0]?.length).toBeGreaterThan(24);
  });
});

describe('webhookHeaders', () => {
  const headers = webhookHeaders({
    eventType: 'lead.created',
    eventId: 'evt',
    deliveryId: 'dlv',
    timestamp: 1_759_000_000,
    signature: 'v1=abc',
  });

  it('carries every header the documentation tells a developer to read', () => {
    expect(headers['x-leados-event']).toBe('lead.created');
    expect(headers['x-leados-event-id']).toBe('evt');
    expect(headers['x-leados-delivery-id']).toBe('dlv');
    expect(headers['x-leados-timestamp']).toBe('1759000000');
    expect(headers['x-leados-signature']).toBe('v1=abc');
  });

  it('separates the delivery from the event, so a retry is not a second event', () => {
    expect(headers['x-leados-delivery-id']).not.toBe(headers['x-leados-event-id']);
  });

  it('declares JSON, because an endpoint parses by content type', () => {
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('buildWebhookPayload', () => {
  const payload = buildWebhookPayload({
    eventId: 'evt_1',
    type: 'lead.created',
    occurredAt: new Date('2026-10-14T10:30:00.000Z'),
    organizationId: 'org_1',
    data: { aggregateId: 'lead_1' },
  });

  it('is the envelope §8 publishes', () => {
    expect(payload).toEqual({
      id: 'evt_1',
      type: 'lead.created',
      occurredAt: '2026-10-14T10:30:00.000Z',
      organizationId: 'org_1',
      apiVersion: 'v1',
      data: { aggregateId: 'lead_1' },
    });
  });

  it('carries the api version, so a payload change is detectable by a consumer', () => {
    expect(payload['apiVersion']).toBe('v1');
  });
});

describe('the retry schedule', () => {
  it('is the one §8 names', () => {
    expect([...RETRY_SCHEDULE_SECONDS]).toEqual([10, 60, 300, 1_800, 7_200, 21_600, 86_400]);
  });

  it('gives a delivery eight attempts in all', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(8);
  });

  it('spaces the attempts by the schedule, within the jitter', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    for (const [index, seconds] of RETRY_SCHEDULE_SECONDS.entries()) {
      const due = nextAttemptAt(index + 1, now, () => 0.5);
      expect(due).not.toBeNull();
      expect((due as Date).getTime() - now.getTime()).toBe(seconds * 1_000);
    }
  });

  it('jitters by ±20 %, so a hundred endpoints do not all come back in one second', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    const earliest = nextAttemptAt(1, now, () => 0) as Date;
    const latest = nextAttemptAt(1, now, () => 1) as Date;
    expect(earliest.getTime() - now.getTime()).toBe(8_000);
    expect(latest.getTime() - now.getTime()).toBe(12_000);
  });

  it('answers null once the schedule is spent, rather than retrying forever', () => {
    expect(nextAttemptAt(RETRY_SCHEDULE_SECONDS.length + 1)).toBeNull();
    expect(nextAttemptAt(99)).toBeNull();
  });

  it('auto-disables on fifteen consecutive failures, as FR-API-4 asks', () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(15);
  });
});

describe('reading the endpoint’s answer', () => {
  it('treats any 2xx as delivered', () => {
    for (const status of [200, 201, 202, 204, 299]) expect(isDeliveredStatus(status)).toBe(true);
  });

  it('does not treat a redirect as an acknowledgement', () => {
    // Following one is how a signed payload reaches an address the SSRF check never saw.
    for (const status of [301, 302, 307, 308]) expect(isDeliveredStatus(status)).toBe(false);
  });

  it('treats everything else as a failure', () => {
    for (const status of [400, 401, 404, 410, 429, 500, 503]) {
      expect(isDeliveredStatus(status)).toBe(false);
    }
  });

  it('disables only on 410, not on the statuses that mean "not right now"', () => {
    expect(isPermanentRejection(410)).toBe(true);
    for (const status of [404, 500, 503, 429]) expect(isPermanentRejection(status)).toBe(false);
  });
});

describe('isBlockedAddress', () => {
  it('refuses loopback, in both families and through a mapped address', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '[::1]']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('refuses the cloud metadata address, which is the whole point of this function', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
  });

  it('refuses every private range', () => {
    for (const address of [
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '255.255.255.255',
      '224.0.0.1',
      'fc00::1',
      'fd12:3456::1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows an ordinary public address', () => {
    for (const address of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('refuses anything it cannot read as an address at all', () => {
    for (const address of ['', '  ', 'not-an-address', '1.2.3', '1.2.3.4.5', '999.1.1.1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });
});

describe('isBlockedHost', () => {
  it('refuses the names that cannot be anything but internal', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'metadata.google.internal',
      'printer.local',
      'api.internal',
      'db.localdomain',
      'thing.home.arpa',
      // A trailing dot is a fully-qualified name and must not be a way round the suffix list.
      'printer.local.',
    ]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
  });

  it('classifies a literal address as an address', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('203.0.113.7')).toBe(false);
  });

  it('allows an ordinary hostname, which only DNS can really judge', () => {
    expect(isBlockedHost('hooks.example.com')).toBe(false);
  });
});

describe('classifyWebhookUrl', () => {
  it('accepts a plain https endpoint', () => {
    expect(classifyWebhookUrl('https://hooks.example.com/leados')).toEqual({
      ok: true,
      hostname: 'hooks.example.com',
    });
  });

  it('refuses http, because a signed payload in clear is still in clear', () => {
    expect(classifyWebhookUrl('http://hooks.example.com/x').reason).toBe('scheme');
  });

  it('refuses a scheme that is not http at all', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com/x']) {
      expect(classifyWebhookUrl(url).reason, url).toBe('scheme');
    }
  });

  it('refuses credentials in the URL', () => {
    expect(classifyWebhookUrl('https://user:pass@hooks.example.com/x').reason).toBe('credentials');
  });

  it('refuses a port that is not the web', () => {
    // 5432 and 6379 are the database and the cache; 22 is ssh.
    for (const port of [22, 25, 5_432, 6_379, 9_200]) {
      expect(classifyWebhookUrl(`https://hooks.example.com:${port}/x`).reason, String(port)).toBe(
        'port',
      );
    }
  });

  it('refuses a private or loopback target', () => {
    for (const url of [
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.1.2.3/x',
      'https://[::1]/x',
      'https://db.internal/x',
    ]) {
      expect(classifyWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses what is not a URL', () => {
    for (const value of ['', 'hooks.example.com/x', 'javascript:alert(1)']) {
      expect(classifyWebhookUrl(value).ok, value).toBe(false);
    }
  });

  it('allows any port where insecure endpoints are allowed, because that is a local machine', () => {
    // A test receiver listens on whatever port the operating system hands it, which is not 443.
    expect(classifyWebhookUrl('http://127.0.0.1:41235/hook', { allowInsecure: true }).ok).toBe(true);
    expect(classifyWebhookUrl('https://hooks.example.com:41235/hook').reason).toBe('port');
  });

  it('lets a development deployment post to localhost, and only a deployment', () => {
    // `allowInsecure` is a deployment setting, never a per-endpoint field: a tenant who could tick
    // it could ask us to post a signed payload over the open internet in clear.
    const verdict = classifyWebhookUrl('http://localhost:4010/hook', { allowInsecure: true });
    expect(verdict.ok).toBe(true);
    expect(classifyWebhookUrl('http://localhost:4010/hook').ok).toBe(false);
  });

  it('has a sentence for every refusal, so no screen has to invent one', () => {
    const reasons = [
      classifyWebhookUrl('').reason,
      classifyWebhookUrl('http://hooks.example.com/x').reason,
      classifyWebhookUrl('https://u:p@hooks.example.com/x').reason,
      classifyWebhookUrl('https://hooks.example.com:22/x').reason,
      classifyWebhookUrl('https://127.0.0.1/x').reason,
    ];
    for (const reason of reasons) {
      expect(reason).toBeDefined();
      expect(URL_REFUSAL_MESSAGES[reason as keyof typeof URL_REFUSAL_MESSAGES]).toBeTruthy();
    }
  });
});
