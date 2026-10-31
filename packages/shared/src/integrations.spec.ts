import { describe, expect, it } from 'vitest';
import {
  INBOUND_VERIFICATIONS,
  INTEGRATION_PROVIDERS,
  flattenGoogleColumnData,
  flattenMetaFieldData,
  MAPPABLE_LEAD_FIELDS,
  applyFieldMapping,
  describeStatus,
  findProvider,
  isMappableTarget,
  mappingProblems,
  needsReconnect,
  nextStatus,
  INTEGRATION_DELIVERY_SHAPES,
  type FieldMapping,
} from './index.js';

describe('the provider registry', () => {
  it('describes each provider well enough for a screen to render the connect form', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(provider.key, provider.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(provider.label.length, provider.key).toBeGreaterThan(2);
      // The summary is what somebody reads before deciding to connect it.
      expect(provider.summary.length, provider.key).toBeGreaterThan(40);
      expect(provider.capabilities.length, provider.key).toBeGreaterThan(0);
      // A secret with no name is a secret the connect form cannot ask for and the adapter cannot
      // read. `shared_secret` providers declare none, because we generate theirs.
      for (const field of provider.credentialFields) {
        expect(field.key, provider.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
        expect(field.label.length, `${provider.key}.${field.key}`).toBeGreaterThan(2);
      }
      if (provider.authKind === 'shared_secret') {
        expect(provider.credentialFields, provider.key).toEqual([]);
      } else {
        expect(provider.credentialFields.length, provider.key).toBeGreaterThan(0);
      }
      // Declared, so the registry's boot check has something to reconcile against.
      expect(INBOUND_VERIFICATIONS, provider.key).toContain(provider.inboundVerification);
      // A provider whose delivery is only a reference must be one that posts to us at all.
      if (provider.deliveryIsAReference) {
        expect(provider.inboundVerification, provider.key).not.toBe('none');
      }
      // The shape the inbound door branches on, and the one thing it must agree with: whether this
      // provider posts to us at all. Everything else about the two is deliberately independent —
      // WhatsApp sends the message in full and still names its own events.
      expect(INTEGRATION_DELIVERY_SHAPES, provider.key).toContain(provider.deliveryShape);
      expect(provider.deliveryShape === 'none', provider.key).toBe(
        provider.inboundVerification === 'none',
      );
      // A reference is a thing the ledger names, so it is always an `events` delivery.
      if (provider.deliveryIsAReference) {
        expect(provider.deliveryShape, provider.key).toBe('events');
      }
      for (const setting of provider.settings) {
        expect(setting.key, provider.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
        expect(setting.label.length, setting.key).toBeGreaterThan(2);
      }
    }
  });

  it('holds only providers whose default mapping is valid', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(mappingProblems([...provider.defaultMapping]), provider.key).toEqual([]);
      // A provider that cannot be mapped must not ship a mapping, or a screen would offer to edit
      // something nothing reads.
      if (!provider.mappable) expect(provider.defaultMapping, provider.key).toEqual([]);
    }
  });

  it('answers for a key it knows and nothing for one it does not', () => {
    expect(findProvider('postmark')?.label).toBe('Postmark');
    expect(findProvider('meta_ads')).toBeUndefined();
  });
});

describe('what a mapping may write', () => {
  it('accepts the capture fields and a custom key, and refuses everything else', () => {
    for (const field of MAPPABLE_LEAD_FIELDS) expect(isMappableTarget(field), field).toBe(true);
    expect(isMappableTarget('custom.property_type')).toBe(true);
    // The fields the workspace's own rules decide are not an integration's to set.
    expect(isMappableTarget('score')).toBe(false);
    expect(isMappableTarget('assignedUserId')).toBe(false);
    expect(isMappableTarget('organizationId')).toBe(false);
    expect(isMappableTarget('custom.Not A Key')).toBe(false);
    expect(isMappableTarget('custom.')).toBe(false);
  });

  it('names every problem at once, rather than one refusal at a time', () => {
    const problems = mappingProblems([
      { source: '', target: 'phone' },
      { source: 'x', target: 'score' },
      { source: 'y', target: 'phone' },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]?.message).toMatch(/Name the field/);
    expect(problems[1]?.message).toMatch(/not a field a connection may write/);
    // Two sources writing one target is a silent last-one-wins, so it is a problem, not a merge.
    expect(problems[2]?.message).toMatch(/both write to/);
  });
});

describe('somebody else’s payload, as ours', () => {
  const mapping: FieldMapping[] = [
    { source: 'field_data.full_name', target: 'name', transform: 'trim' },
    { source: 'field_data.mobile', target: 'phone', transform: 'phone' },
    { source: 'field_data.email', target: 'email', transform: 'lowercase' },
    { source: 'answers.0.value', target: 'custom.property_type' },
    { source: 'consented', target: 'custom.marketing_ok', transform: 'boolean' },
  ];

  it('reads dot paths and array indexes, which is how every ad platform nests', () => {
    const result = applyFieldMapping(
      {
        field_data: {
          full_name: '  Asha Patel ',
          mobile: '(+91) 98450-12345',
          email: 'ASHA@Example.COM',
        },
        answers: [{ value: 'Apartment' }],
        consented: 'Yes',
      },
      mapping,
    );
    expect(result.mapped['name']).toBe('Asha Patel');
    expect(result.mapped['phone']).toBe('+919845012345');
    expect(result.mapped['email']).toBe('asha@example.com');
    expect(result.mapped['customFields']).toEqual({
      property_type: 'Apartment',
      marketing_ok: true,
    });
  });

  it('reports a source the payload did not carry rather than inventing one', () => {
    const result = applyFieldMapping({ field_data: { full_name: 'Asha' } }, mapping);
    expect(result.mapped['name']).toBe('Asha');
    expect(result.mapped['phone']).toBeUndefined();
    // What a screen shows when a mapping was written against last month's payload.
    expect(result.missing).toContain('field_data.mobile');
    expect(result.missing).toContain('answers.0.value');
  });

  it('treats an empty string as absent, because a blank field is not an answer', () => {
    const result = applyFieldMapping({ field_data: { mobile: '' } }, mapping);
    expect(result.mapped['phone']).toBeUndefined();
    expect(result.missing).toContain('field_data.mobile');
  });

  it('keeps the keys no entry named, so the one-click custom field still reaches them', () => {
    const result = applyFieldMapping(
      { field_data: { full_name: 'Asha' }, campaign_id: 'abc', agent_code: 'NW-1' },
      mapping,
    );
    expect(result.unmapped).toEqual(['campaign_id', 'agent_code']);
  });

  it('reads a boolean the way a form sends one', () => {
    for (const yes of ['Yes', 'true', '1', 'on', 'AGREED']) {
      const result = applyFieldMapping({ consented: yes }, mapping);
      expect((result.mapped['customFields'] as Record<string, unknown>)['marketing_ok'], yes).toBe(
        true,
      );
    }
    const no = applyFieldMapping({ consented: 'no' }, mapping);
    expect((no.mapped['customFields'] as Record<string, unknown>)['marketing_ok']).toBe(false);
  });

  it('does not walk into a value that is not an object', () => {
    const result = applyFieldMapping({ field_data: 'not an object' }, mapping);
    expect(result.mapped).toEqual({});
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('maps a number as a string, because a phone number arriving as a number is still a phone', () => {
    const result = applyFieldMapping({ field_data: { mobile: 9845012345 } }, [
      { source: 'field_data.mobile', target: 'phone', transform: 'phone' },
    ]);
    expect(result.mapped['phone']).toBe('9845012345');
  });
});

describe('what a probe means for the connection', () => {
  it('makes an unauthorized probe a reconnect, with no grace period', () => {
    expect(nextStatus('connected', 'unauthorized')).toBe('revoked');
    expect(needsReconnect('revoked')).toBe(true);
    expect(needsReconnect('degraded')).toBe(false);
    expect(needsReconnect('error')).toBe(false);
  });

  it('gives a provider one bad minute before calling it broken', () => {
    expect(nextStatus('connected', 'unreachable')).toBe('degraded');
    expect(nextStatus('degraded', 'unreachable')).toBe('error');
    expect(nextStatus('error', 'unreachable')).toBe('error');
  });

  it('escalates a provider that answers and refuses, exactly as one that does not answer', () => {
    // The difference between the two is diagnostic — one carries a latency and one cannot — not a
    // severity. A connection whose provider has answered 500 all afternoon must not still read
    // "nothing to do yet".
    expect(nextStatus('connected', 'degraded')).toBe('degraded');
    expect(nextStatus('degraded', 'degraded')).toBe('error');
    expect(nextStatus('error', 'degraded')).toBe('error');
  });

  it('recovers on the first good probe, from any state', () => {
    for (const from of ['connected', 'degraded', 'error', 'revoked'] as const) {
      expect(nextStatus(from, 'ok'), from).toBe('connected');
    }
  });

  it('says what each standing means, and never the same sentence twice', () => {
    const sentences = (['connected', 'degraded', 'error', 'revoked'] as const).map((status) =>
      describeStatus(status, '2026-10-19T00:00:00.000Z'),
    );
    expect(new Set(sentences).size).toBe(4);
    // A connection nothing has used yet is not the same as one that is working.
    expect(describeStatus('connected', null)).not.toBe(
      describeStatus('connected', '2026-10-19T00:00:00.000Z'),
    );
    expect(describeStatus('revoked', null)).toMatch(/reconnect/);
  });
});

describe('the providers that bring leads in', () => {
  const metaEntry = INTEGRATION_PROVIDERS.find((provider) => provider.key === 'meta_lead_ads')!;
  const googleEntry = INTEGRATION_PROVIDERS.find(
    (provider) => provider.key === 'google_ads_leads',
  )!;

  it('starts Meta with a mapping that matches what Meta actually sends', () => {
    // The point of a default mapping: the connection works the moment it is made. Each source here
    // is a key `flattenMetaFieldData` produces from Meta's own standard questions, which is what
    // makes this assertion more than a restatement of the constant.
    const flat = flattenMetaFieldData({
      field_data: [
        { name: 'full_name', values: ['Asha Rao'] },
        { name: 'phone_number', values: ['+919845012345'] },
        { name: 'email', values: ['ASHA@example.test'] },
        { name: 'city', values: ['Bengaluru'] },
        { name: 'company_name', values: ['Rao Interiors'] },
      ],
    });
    for (const entry of metaEntry.defaultMapping) {
      expect(flat[entry.source], entry.source).toBeDefined();
    }
    const mapped = applyFieldMapping(flat, metaEntry.defaultMapping);
    expect(mapped.mapped['name']).toBe('Asha Rao');
    expect(mapped.mapped['email']).toBe('asha@example.test');
    expect(mapped.missing).toEqual([]);
  });

  it('keeps every answer to a question somebody answered twice', () => {
    // Taking the first would silently discard an answer a person gave. A checkbox group is the
    // commonest case, and the one a mapping can still read a single value out of.
    const flat = flattenMetaFieldData({
      field_data: [{ name: 'interested_in', values: ['Kitchen', 'Wardrobe'] }],
    });
    expect(flat['interested_in']).toBe('Kitchen, Wardrobe');
  });

  it('leaves a Meta payload alone when it carries no field data', () => {
    expect(flattenMetaFieldData({ leadgen_id: '1' })).toEqual({ leadgen_id: '1' });
    expect(flattenMetaFieldData({ field_data: 'not an array' })).toEqual({
      field_data: 'not an array',
    });
    // An entry with no values is skipped rather than written as undefined: a key whose value is
    // undefined reads as "answered with nothing" to a mapping.
    expect(flattenMetaFieldData({ field_data: [{ name: 'city', values: [] }] })['city']).toBe(
      undefined,
    );
  });

  it('starts Google Ads with a mapping that matches its column ids', () => {
    const flat = flattenGoogleColumnData({
      lead_id: 'abc',
      user_column_data: [
        { column_id: 'FULL_NAME', column_name: 'Full name', string_value: 'Asha Rao' },
        { column_id: 'PHONE_NUMBER', column_name: 'Phone', string_value: '+91 98450 12345' },
        { column_id: 'EMAIL', column_name: 'Email', string_value: 'ASHA@example.test' },
        { column_id: 'CITY', column_name: 'City', string_value: 'Bengaluru' },
        { column_id: 'COMPANY_NAME', column_name: 'Company', string_value: 'Rao Interiors' },
      ],
    });
    for (const entry of googleEntry.defaultMapping) {
      expect(flat[entry.source], entry.source).toBeDefined();
    }
    const mapped = applyFieldMapping(flat, googleEntry.defaultMapping);
    expect(mapped.mapped['name']).toBe('Asha Rao');
    // The phone transform keeps the country code and drops the spaces.
    expect(mapped.mapped['phone']).toBe('+919845012345');
    expect(mapped.missing).toEqual([]);
  });

  it('keys a Google column by its id, and falls back to its name only for a custom question', () => {
    const flat = flattenGoogleColumnData({
      user_column_data: [
        { column_id: 'FULL_NAME', column_name: 'Full name', string_value: 'Asha' },
        // A custom question has no standard id; its name is the only key there is.
        { column_name: 'Budget', string_value: '45,00,000' },
        // Nothing to key on at all, and nothing to lose by skipping it.
        { string_value: 'orphan' },
        // An unanswered question is skipped rather than written as an empty string, which a
        // mapping would otherwise store as a blank city.
        { column_id: 'CITY', string_value: '' },
      ],
    });
    expect(flat['FULL_NAME']).toBe('Asha');
    expect(flat['Budget']).toBe('45,00,000');
    expect(flat['CITY']).toBe(undefined);
    expect(Object.values(flat)).not.toContain('orphan');
  });

  it('declares both of them as mappable providers that post to us', () => {
    for (const entry of [metaEntry, googleEntry]) {
      expect(entry.mappable, entry.key).toBe(true);
      expect(entry.capabilities, entry.key).toContain('lead_ingest');
      expect(entry.inboundVerification, entry.key).not.toBe('none');
      // Every target in a default mapping has to be one a mapping may write, or the connection is
      // born refusing to save.
      for (const mapping of entry.defaultMapping) {
        expect(isMappableTarget(mapping.target), `${entry.key} → ${mapping.target}`).toBe(true);
      }
      expect(mappingProblems(entry.defaultMapping), entry.key).toEqual([]);
    }
    // Meta is the one whose delivery is a reference: it sends an id, not the answers.
    expect(metaEntry.deliveryIsAReference).toBe(true);
    expect(googleEntry.deliveryIsAReference).toBe(false);
    // Both name their own events, which is a different fact from the one above.
    expect(metaEntry.deliveryShape).toBe('events');
    expect(googleEntry.deliveryShape).toBe('events');
  });
});
