import { describe, expect, it } from 'vitest';
import {
  API_KEY_SCOPES as SHARED_SCOPES,
  INBOUND_STATUSES as SHARED_STATUSES,
  INGESTION_STAGES as SHARED_STAGES,
  INGEST_CHANNELS as SHARED_CHANNELS,
  isValidCustomFieldKey,
  customFieldKeyFor,
  CUSTOM_FIELD_TYPES,
} from '@leados/shared';
import {
  API_KEY_SCOPES,
  FIELD_TYPE_CHOICES,
  CHANNEL_LABELS,
  INBOUND_STATUSES,
  INGESTION_STAGES,
  INGEST_CHANNELS,
  PAYLOAD_STATUS_CLASSES,
  PAYLOAD_STATUS_LABELS,
  SCOPE_LABELS,
  STAGE_LABELS,
  curlSnippet,
  describeIngestion,
  describeKeyUse,
  keyStanding,
  suggestedFieldKey,
  suggestedFieldLabel,
  suggestedFieldType,
  type ApiKeyRecord,
} from './ingestion';

/**
 * The reconciliation this file exists for.
 *
 * `lib/ingestion.ts` hand-writes the ingestion vocabulary because `@leados/shared`'s entry point
 * reaches `node:async_hooks` and a client component that imports it fails `next build`. A spec runs
 * in Node and may import both, so the copy is checked rather than trusted: a scope this app offers
 * that the API refuses is a key that cannot be created, and a status the API sends that this app
 * does not know renders as a blank chip.
 */
describe('the ingestion vocabulary matches the API', () => {
  it('declares the same channels, statuses, stages and scopes', () => {
    expect([...INGEST_CHANNELS]).toEqual([...SHARED_CHANNELS]);
    expect([...INBOUND_STATUSES]).toEqual([...SHARED_STATUSES]);
    expect([...INGESTION_STAGES]).toEqual([...SHARED_STAGES]);
    expect([...API_KEY_SCOPES]).toEqual([...SHARED_SCOPES]);
  });

  it('has a label for every value, so nothing renders as a blank chip', () => {
    for (const channel of SHARED_CHANNELS) expect(CHANNEL_LABELS[channel]).toBeTruthy();
    for (const status of SHARED_STATUSES) {
      expect(PAYLOAD_STATUS_LABELS[status]).toBeTruthy();
      expect(PAYLOAD_STATUS_CLASSES[status]).toBeTruthy();
    }
    for (const stage of SHARED_STAGES) expect(STAGE_LABELS[stage]).toBeTruthy();
    for (const scope of SHARED_SCOPES) expect(SCOPE_LABELS[scope]).toBeTruthy();
  });

  it('never labels a stage with the stage name itself', () => {
    // The whole point of the stage is that a tenant can act on it; "normalize" is a word from our
    // architecture, not an instruction.
    for (const stage of SHARED_STAGES) expect(STAGE_LABELS[stage]).not.toBe(stage);
  });
});

function key(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'k1',
    name: 'Website',
    keyPrefix: 'pk_live_7f3c9a2b',
    scopes: ['ingest:write'],
    ipAllowlist: [],
    rateLimitPerMin: null,
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    isLive: true,
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('keyStanding', () => {
  it('reads a live key as live', () => {
    expect(keyStanding(key()).label).toBe('Live');
  });

  it('separates expired from revoked, because they are different problems', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    expect(keyStanding(key({ expiresAt: '2026-10-01T00:00:00.000Z' }), now)).toEqual({
      label: 'Expired',
      tone: 'warning',
    });
    expect(keyStanding(key({ revokedAt: '2026-10-02T00:00:00.000Z' }), now).label).toBe('Revoked');
  });

  it('prefers revoked when a key is both, because that is the deliberate one', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    const both = key({ expiresAt: '2026-10-01T00:00:00.000Z', revokedAt: '2026-10-02T00:00:00Z' });
    expect(keyStanding(both, now).label).toBe('Revoked');
  });

  it('is still live on the day it expires', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    expect(keyStanding(key({ expiresAt: '2026-10-14T23:59:00.000Z' }), now).label).toBe('Live');
  });
});

describe('describeKeyUse', () => {
  it('says so plainly when nothing has ever used the key', () => {
    expect(describeKeyUse(key())).toContain('Never used');
  });

  it('names the address, because "it works from my laptop" is the commonest next question', () => {
    const sentence = describeKeyUse(
      key({ lastUsedAt: '2026-10-14T09:30:00.000Z', lastUsedIp: '203.0.113.7' }),
      new Date('2026-10-14T10:00:00.000Z'),
    );
    expect(sentence).toBe('Last used 30 minutes ago, from 203.0.113.7.');
  });

  it('omits the address rather than printing a dash when it was not recorded', () => {
    const sentence = describeKeyUse(
      key({ lastUsedAt: '2026-10-14T09:00:00.000Z' }),
      new Date('2026-10-14T10:00:00.000Z'),
    );
    expect(sentence).toBe('Last used 1 hour ago.');
  });
});

describe('suggestedFieldKey', () => {
  it('turns an integrator’s camelCase into the key rule the API enforces', () => {
    expect(suggestedFieldKey('propertyType')).toBe('property_type');
    expect(suggestedFieldKey('Budget Band')).toBe('budget_band');
    expect(suggestedFieldKey('utm-term')).toBe('utm_term');
  });

  it('produces only keys the API would accept', () => {
    for (const field of ['propertyType', 'budget band', 'possession_quarter', 'leadScore2']) {
      const suggestion = suggestedFieldKey(field);
      expect(suggestion).not.toBeNull();
      expect(isValidCustomFieldKey(suggestion as string)).toBe(true);
    }
  });

  it('refuses rather than offering a button that is certain to be refused', () => {
    // A reserved name, a key that cannot start with a digit, and nothing at all.
    expect(suggestedFieldKey('phone')).toBeNull();
    expect(suggestedFieldKey('2ndPhone')).toBeNull();
    expect(suggestedFieldKey('   ')).toBeNull();
    expect(suggestedFieldKey('x')).toBeNull();
  });

  it('derives exactly what the API’s own mapper derives', () => {
    // The whole reason both exist: the button fills its key box from this copy, and the mapper
    // matches an integration's top-level key with the shared one. A copy that has drifted creates
    // a field the next payload does not fill in — a feature that looks built.
    for (const field of [
      'propertyType',
      'Budget Band',
      'utm-term',
      'possession_quarter',
      'phone',
      '2ndPhone',
      '   ',
      'x',
      'leadScore2',
    ]) {
      expect(suggestedFieldKey(field)).toBe(customFieldKeyFor(field));
    }
  });

  it('only refuses names the shared rule also refuses', () => {
    // The reserved list is copied here, and a copy that has drifted would hide the button for a
    // field that is perfectly creatable.
    const reserved = ['phone', 'email', 'source', 'owner', 'value', 'tags'];
    for (const name of reserved) expect(isValidCustomFieldKey(name)).toBe(false);
  });
});

describe('suggestedFieldLabel', () => {
  it('splits camelCase, not only snake_case', () => {
    expect(suggestedFieldLabel('propertyType')).toBe('Property type');
    expect(suggestedFieldLabel('possession_quarter')).toBe('Possession quarter');
    expect(suggestedFieldLabel('utm-term')).toBe('Utm term');
  });

  it('leaves a field with nothing to split alone', () => {
    expect(suggestedFieldLabel('budget')).toBe('Budget');
  });
});

describe('suggestedFieldType', () => {
  it('suggests a type the API would accept', () => {
    const suggestions = [
      suggestedFieldType([]),
      suggestedFieldType(['yes', 'no']),
      suggestedFieldType(['rohit@example.com']),
      suggestedFieldType(['https://example.com/x']),
      suggestedFieldType(['+919845012345']),
      suggestedFieldType(['42']),
      suggestedFieldType(['42.5']),
      suggestedFieldType(['2026-02-14']),
      suggestedFieldType(['Apartment', 'Villa', 'Apartment']),
      suggestedFieldType(['anything at all']),
    ];
    for (const suggestion of suggestions) {
      expect(CUSTOM_FIELD_TYPES).toContain(suggestion as (typeof CUSTOM_FIELD_TYPES)[number]);
    }
  });

  it('only ever suggests a type the dropdown actually offers', () => {
    // A suggestion missing from the list would preselect nothing, and the one click would quietly
    // create a text field for a date.
    const offered = FIELD_TYPE_CHOICES.map((choice) => choice.type);
    const samples = [
      [] as string[],
      ['yes', 'no'],
      ['rohit@example.com'],
      ['https://example.com/x'],
      ['+919845012345'],
      ['42'],
      ['42.5'],
      ['2026-02-14'],
      ['Apartment', 'Villa', 'Apartment'],
      ['anything at all'],
    ];
    for (const sample of samples) expect(offered).toContain(suggestedFieldType(sample));
  });

  it('offers only types the API accepts', () => {
    for (const choice of FIELD_TYPE_CHOICES) {
      expect(CUSTOM_FIELD_TYPES).toContain(choice.type as (typeof CUSTOM_FIELD_TYPES)[number]);
      expect(choice.label).toBeTruthy();
    }
  });

  it('reads a repeated short vocabulary as a choice list', () => {
    expect(suggestedFieldType(['Apartment', 'Villa', 'Apartment'])).toBe('select');
  });

  it('does not call two different values a choice list on no evidence', () => {
    expect(suggestedFieldType(['Apartment', 'Villa'])).toBe('text');
  });

  it('falls back to text, which accepts everything already sent', () => {
    expect(suggestedFieldType([])).toBe('text');
    expect(suggestedFieldType(['', '  '])).toBe('text');
  });
});

describe('curlSnippet', () => {
  const snippet = curlSnippet({
    baseUrl: 'http://localhost:4000/',
    organizationPublicKey: 'pk_live_workspace',
  });

  it('posts to this workspace’s own public key', () => {
    expect(snippet).toContain(
      'curl -X POST http://localhost:4000/api/v1/public/leads/pk_live_workspace',
    );
  });

  it('signs "<timestamp>.<body>", which is what the API verifies', () => {
    expect(snippet).toContain(`printf '%s.%s' "$TS" "$BODY"`);
    expect(snippet).toContain('X-Signature: t=$TS,v1=$SIG');
    expect(snippet).toContain('X-Api-Key: $LEADOS_KEY_ID');
  });

  it('never contains a secret — it reads one from the person’s own shell', () => {
    expect(snippet).toContain('$LEADOS_SECRET');
    expect(snippet).not.toMatch(/sk_live_[A-Za-z0-9]{4,}/);
  });
});

describe('describeIngestion', () => {
  it('says nothing has arrived rather than printing noughts', () => {
    expect(describeIngestion({ total: 0, failed: 0, unmappedFields: 0 })).toBe(
      'Nothing has been posted to the lead API yet.',
    );
  });

  it('counts to one in every clause', () => {
    expect(describeIngestion({ total: 1, failed: 1, unmappedFields: 1 })).toBe(
      '1 payload stored · 1 that did not become a lead · 1 field with nowhere to go.',
    );
  });

  it('omits what is zero instead of saying "0 fields"', () => {
    const sentence = describeIngestion({ total: 4, failed: 0, unmappedFields: 0 });
    expect(sentence).toBe('4 payloads stored · every one of them accounted for.');
    expect(sentence).not.toMatch(/\b0\b/);
  });

  it('reads as a sentence when several things are wrong', () => {
    expect(describeIngestion({ total: 9, failed: 2, unmappedFields: 3 })).toBe(
      '9 payloads stored · 2 that did not become leads · 3 fields with nowhere to go.',
    );
  });
});
