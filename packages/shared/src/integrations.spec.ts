import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_PROVIDERS,
  MAPPABLE_LEAD_FIELDS,
  applyFieldMapping,
  describeStatus,
  findProvider,
  isMappableTarget,
  mappingProblems,
  needsReconnect,
  nextStatus,
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
        field_data: { full_name: '  Asha Patel ', mobile: '(+91) 98450-12345', email: 'ASHA@Example.COM' },
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
      expect((result.mapped['customFields'] as Record<string, unknown>)['marketing_ok'], yes).toBe(true);
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
    expect(describeStatus('connected', null)).not.toBe(describeStatus('connected', '2026-10-19T00:00:00.000Z'));
    expect(describeStatus('revoked', null)).toMatch(/reconnect/);
  });
});
