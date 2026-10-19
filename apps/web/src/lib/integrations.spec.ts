import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_PROVIDERS,
  INTEGRATION_STATUSES as SHARED_STATUSES,
  MAPPABLE_LEAD_FIELDS as SHARED_FIELDS,
  MAPPING_TRANSFORMS as SHARED_TRANSFORMS,
  PROBE_OUTCOMES as SHARED_OUTCOMES,
  describeStatus as sharedDescribeStatus,
  isMappableTarget as sharedIsMappableTarget,
} from '@leados/shared';
import {
  FIELD_LABELS,
  INTEGRATION_STATUSES,
  MAPPABLE_LEAD_FIELDS,
  MAPPING_TRANSFORMS,
  OUTCOME_LABELS,
  PROBE_OUTCOMES,
  STATUS_CLASSES,
  STATUS_LABELS,
  TRANSFORM_LABELS,
  describeActivity,
  describeCheck,
  describeIntegrations,
  describeStatus,
  inboundInstruction,
  inboundUrl,
  isMappableTarget,
  needsReconnect,
  signingSnippet,
  type ConnectionRecord,
} from './integrations';

/**
 * The reconciliation this file exists for.
 *
 * `lib/integrations.ts` hand-writes the vocabulary because `@leados/shared`'s entry point reaches
 * `node:async_hooks` and a client component that imports it fails `next build`. A spec runs in Node
 * and may import both: a target this screen offers that the API refuses is a mapping somebody
 * writes and cannot save, and one the API accepts that this screen omits is a field nobody can map.
 */
describe('the vocabulary matches the API', () => {
  it('offers exactly the fields, transforms, statuses and outcomes the API knows', () => {
    expect([...MAPPABLE_LEAD_FIELDS]).toEqual([...SHARED_FIELDS]);
    expect([...MAPPING_TRANSFORMS]).toEqual([...SHARED_TRANSFORMS]);
    expect([...INTEGRATION_STATUSES]).toEqual([...SHARED_STATUSES]);
    expect([...PROBE_OUTCOMES]).toEqual([...SHARED_OUTCOMES]);
  });

  it('decides a mapping target exactly as the API does', () => {
    for (const target of [
      ...MAPPABLE_LEAD_FIELDS,
      'custom.budget',
      'custom.property_type',
      'score',
      'assignedUserId',
      'custom.Not A Key',
      'custom.',
      '',
      'phone ',
    ]) {
      // A screen that accepted what the API refuses would produce a 400 on save; one that refused
      // what the API accepts would hide a field nobody could then map.
      expect(isMappableTarget(target), target).toBe(sharedIsMappableTarget(target));
    }
  });

  it('says the same sentence about a standing as the API does', () => {
    for (const status of INTEGRATION_STATUSES) {
      expect(describeStatus(status, '2026-10-19T00:00:00.000Z'), status).toBe(
        sharedDescribeStatus(status, '2026-10-19T00:00:00.000Z'),
      );
      expect(describeStatus(status, null), status).toBe(sharedDescribeStatus(status, null));
    }
  });

  it('has a label and a colour for every standing, and a label for every outcome', () => {
    for (const status of INTEGRATION_STATUSES) {
      expect(STATUS_LABELS[status], status).toBeTruthy();
      expect(STATUS_CLASSES[status], status).toBeTruthy();
      // A chip reading the schema's own word is a screen written for the schema.
      expect(STATUS_LABELS[status]).not.toBe(status);
    }
    for (const outcome of PROBE_OUTCOMES) {
      expect(OUTCOME_LABELS[outcome], outcome).toBeTruthy();
      expect(OUTCOME_LABELS[outcome]).not.toBe(outcome);
    }
  });

  it('has a sentence for every field and every transform, so no box is a bare schema name', () => {
    for (const field of MAPPABLE_LEAD_FIELDS) {
      expect(FIELD_LABELS[field], field).toBeTruthy();
      expect(FIELD_LABELS[field]).not.toBe(field);
    }
    for (const transform of MAPPING_TRANSFORMS) {
      expect(TRANSFORM_LABELS[transform], transform).toBeTruthy();
    }
  });

  it('renders a form for every provider from the registry alone', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      // What the screen needs in order to ask for this provider's secrets without knowing anything
      // about it: a name, a label and whether it is required. A provider that generates its own
      // secret declares none, and the screen says so instead of rendering an empty box.
      for (const field of provider.credentialFields) {
        expect(field.key, provider.key).toBeTruthy();
        expect(field.label, `${provider.key}.${field.key}`).toBeTruthy();
      }
      // And what it needs to decide whether to show an inbound address at all.
      expect(['hmac_header', 'payload_key', 'none']).toContain(provider.inboundVerification);
    }
  });

  it('has an instruction for every provider that posts to us, and none that is generic', () => {
    const posting = INTEGRATION_PROVIDERS.filter(
      (provider) => provider.inboundVerification !== 'none',
    );
    expect(posting.length).toBeGreaterThan(1);
    const sentences = posting.map((provider) => inboundInstruction(provider.key));
    // A sentence per provider, because "post leads here" is not what somebody configuring Google
    // Ads or Meta needs to read — they need to know which box to paste it into.
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(40);
  });

  it('knows which providers exist without a second list', () => {
    // The screen renders the catalogue the API answers, so this is about the *registry* being
    // non-empty and well formed rather than about a copy of it living here.
    expect(INTEGRATION_PROVIDERS.length).toBeGreaterThan(1);
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const entry of provider.defaultMapping) {
        expect(isMappableTarget(entry.target), `${provider.key} → ${entry.target}`).toBe(true);
      }
    }
  });
});

describe('the summary sentence', () => {
  it('counts to one without reading as machine output', () => {
    expect(describeIntegrations({ connected: 1, needsAttention: 1, available: 1 })).toBe(
      '1 connection · 1 needs your attention.',
    );
    expect(describeIntegrations({ connected: 2, needsAttention: 2, available: 1 })).toBe(
      '2 connections · 2 need your attention.',
    );
  });

  it('says what to do when nothing is connected, with the right plural', () => {
    expect(describeIntegrations({ connected: 0, needsAttention: 0, available: 1 })).toContain(
      '1 provider is available',
    );
    expect(describeIntegrations({ connected: 0, needsAttention: 0, available: 3 })).toContain(
      '3 providers are available',
    );
  });

  it('omits what is zero rather than printing a nought', () => {
    const sentence = describeIntegrations({ connected: 2, needsAttention: 0, available: 0 });
    // Not `/ 0 /`: a zero at the start or the end of the string would slip through that, which is
    // how the Today summary's "0 follow-ups left · 1 overdue" survived its own test.
    expect(sentence).not.toMatch(/\b0\b/);
    expect(sentence).toBe('2 connections · all working.');
  });
});

describe('what a row says about itself', () => {
  const base: ConnectionRecord = {
    id: 'c1',
    provider: 'postmark',
    providerLabel: 'Postmark',
    capabilities: ['email_send'],
    authKind: 'api_key',
    name: 'Transactional email',
    externalAccountId: null,
    settings: {},
    fieldMappings: [],
    status: 'connected',
    statusSummary: 'Working.',
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    disconnectedAt: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    recentChecks: [],
  };
  const now = new Date('2026-10-19T12:00:00.000Z');

  it('distinguishes never used from working from broken', () => {
    expect(describeActivity(base, now)).toBe('Nothing has used it yet.');
    expect(
      describeActivity({ ...base, lastSuccessAt: '2026-10-19T11:30:00.000Z' }, now),
    ).toMatch(/^Last worked /);
    expect(
      describeActivity(
        {
          ...base,
          status: 'revoked',
          lastErrorAt: '2026-10-19T11:00:00.000Z',
          lastError: '401: No account or server API tokens were supplied.',
        },
        now,
      ),
    ).toMatch(/^Never worked — last failed .*401/);
  });

  it('keeps the provider’s own words rather than paraphrasing them', () => {
    const sentence = describeActivity(
      {
        ...base,
        lastSuccessAt: '2026-10-19T09:00:00.000Z',
        lastErrorAt: '2026-10-19T11:00:00.000Z',
        lastError: '500: Server error',
      },
      now,
    );
    expect(sentence).toContain('500: Server error');
  });

  it('reads a probe without a latency as "no answer", never as 0 ms', () => {
    expect(
      describeCheck({ outcome: 'unreachable', latencyMs: null, checkedAt: now.toISOString(), detail: {} }, now),
    ).toContain('no answer');
    expect(
      describeCheck(
        { outcome: 'ok', latencyMs: 142, checkedAt: now.toISOString(), detail: {} },
        now,
      ),
    ).toContain('142 ms');
  });

  it('says only revoked needs a person', () => {
    expect(needsReconnect('revoked')).toBe(true);
    for (const status of ['connected', 'degraded', 'error'] as const) {
      expect(needsReconnect(status), status).toBe(false);
    }
  });
});

describe('what a sender is told', () => {
  it('builds one inbound URL, whatever the base ends with', () => {
    expect(inboundUrl('http://localhost:4000', 'generic_webhook', 'abc')).toBe(
      'http://localhost:4000/api/v1/wh/generic_webhook/abc',
    );
    expect(inboundUrl('http://localhost:4000/', 'generic_webhook', 'abc')).toBe(
      'http://localhost:4000/api/v1/wh/generic_webhook/abc',
    );
  });

  it('shows the signing a sender has to write, over the raw bytes', () => {
    const snippet = signingSnippet('http://localhost:4000/api/v1/wh/generic_webhook/abc');
    expect(snippet).toContain('createHmac');
    // The exact bytes, and the header shape the verifier parses.
    expect(snippet).toContain('t=${t},v1=${v1}');
    expect(snippet).toContain('${t}.${body}');
    expect(snippet).toContain('http://localhost:4000/api/v1/wh/generic_webhook/abc');
    // And never the secret itself, only where to read it from.
    expect(snippet).not.toMatch(/whsec_[A-Za-z0-9]/);
  });
});
