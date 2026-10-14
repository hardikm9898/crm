import { describe, expect, it } from 'vitest';
import { isValidCustomFieldKey } from './custom-fields.js';
import {
  API_KEY_SCOPES,
  INBOUND_STATUSES,
  INGEST_CHANNELS,
  INGESTION_STAGES,
  SIGNATURE_TOLERANCE_SECONDS,
  customFieldKeyFor,
  dedupeHash,
  derivedIdempotencyKey,
  generateApiKey,
  signRequest,
  signaturePayload,
  splitFullName,
  unmappedKeys,
  verifySignature,
} from './ingestion.js';

/**
 * The public ingestion API's cryptography, tested as the thing an attacker reaches.
 *
 * Every assertion about `verifySignature` is a refusal: a missing header, a malformed one, a replay
 * outside the window, a modified body, the wrong secret. A verifier that only has a happy-path test
 * is one nobody has tried to break.
 */
describe('the key pair', () => {
  it('is prefixed so a leaked secret is recognisable as one', () => {
    const key = generateApiKey();
    expect(key.keyId.startsWith('pk_live_')).toBe(true);
    expect(key.secret.startsWith('sk_live_')).toBe(true);
    expect(key.prefix).toBe(key.keyId.slice(0, 16));
  });

  it('is long enough not to be guessed, and never repeats', () => {
    const keys = Array.from({ length: 50 }, () => generateApiKey());
    expect(new Set(keys.map((key) => key.keyId)).size).toBe(50);
    expect(new Set(keys.map((key) => key.secret)).size).toBe(50);
    for (const key of keys) {
      expect(key.secret.length).toBeGreaterThanOrEqual(32);
    }
  });
});

describe('verifySignature', () => {
  const secret = 'sk_live_test_secret';
  const body = '{"phone":"9845012345"}';
  const now = new Date('2026-10-14T20:00:00.000Z');
  const timestamp = Math.floor(now.getTime() / 1000);

  it('accepts a signature over the raw body', () => {
    const header = signRequest(secret, timestamp, body);
    expect(verifySignature(secret, header, body, now)).toEqual({ ok: true });
  });

  it('signs "<timestamp>.<body>", and says so in one place', () => {
    expect(signaturePayload(1759000000, '{}')).toBe('1759000000.{}');
  });

  it('refuses a missing header', () => {
    expect(verifySignature(secret, undefined, body, now)).toEqual({
      ok: false,
      failure: 'missing',
    });
    expect(verifySignature(secret, '   ', body, now).failure).toBe('missing');
  });

  it('refuses a header that is not the documented shape', () => {
    for (const header of [
      'nonsense',
      't=abc,v1=deadbeef',
      'v1=deadbeef',
      `t=${timestamp}`,
      `t=${timestamp},v1=zz`,
    ]) {
      expect(verifySignature(secret, header, body, now).failure, header).toBe('malformed');
    }
  });

  it('refuses a replay from outside the window, and allows one inside it', () => {
    const old = timestamp - SIGNATURE_TOLERANCE_SECONDS - 1;
    expect(verifySignature(secret, signRequest(secret, old, body), body, now).failure).toBe(
      'stale',
    );
    const recent = timestamp - SIGNATURE_TOLERANCE_SECONDS + 5;
    expect(verifySignature(secret, signRequest(secret, recent, body), body, now).ok).toBe(true);
    // A clock set in the future is the same problem in the other direction.
    const ahead = timestamp + SIGNATURE_TOLERANCE_SECONDS + 1;
    expect(verifySignature(secret, signRequest(secret, ahead, body), body, now).failure).toBe(
      'stale',
    );
  });

  it('refuses a body that changed by one byte', () => {
    const header = signRequest(secret, timestamp, body);
    expect(verifySignature(secret, header, '{"phone":"9845012346"}', now).failure).toBe('mismatch');
  });

  it('refuses the wrong secret', () => {
    const header = signRequest('sk_live_someone_else', timestamp, body);
    expect(verifySignature(secret, header, body, now).failure).toBe('mismatch');
  });

  it('refuses a signature made over a re-serialised body, which is the point of using the raw one', () => {
    // The same object, different bytes. A verifier that re-serialised would accept this and would
    // then reject every client whose JSON writer spaces things differently from ours.
    const header = signRequest(secret, timestamp, '{ "phone": "9845012345" }');
    expect(verifySignature(secret, header, body, now).failure).toBe('mismatch');
  });
});

describe('idempotency', () => {
  it('derives a key from the body when the client sent none', () => {
    const one = derivedIdempotencyKey('public_api', '{"phone":"1"}');
    expect(one.startsWith('derived_')).toBe(true);
    expect(derivedIdempotencyKey('public_api', '{"phone":"1"}')).toBe(one);
    expect(derivedIdempotencyKey('public_api', '{"phone":"2"}')).not.toBe(one);
  });

  it('keeps the channels apart, because the key is unique per channel', () => {
    expect(derivedIdempotencyKey('public_api', '{}')).not.toBe(
      derivedIdempotencyKey('meta_ads', '{}'),
    );
  });

  it('marks a derived key as derived, so a collapsed pair of submissions is explainable', () => {
    expect(derivedIdempotencyKey('public_api', '{}')).toMatch(/^derived_[0-9a-f]{40}$/);
  });

  it('fingerprints a body the same way every time', () => {
    expect(dedupeHash('{"a":1}')).toBe(dedupeHash('{"a":1}'));
    expect(dedupeHash('{"a":1}')).not.toBe(dedupeHash('{"a":2}'));
  });
});

describe('splitFullName', () => {
  it('treats the last word as the surname', () => {
    expect(splitFullName('Priya Sharma Nair')).toEqual({
      firstName: 'Priya Sharma',
      lastName: 'Nair',
    });
  });

  it('leaves a single word as a first name', () => {
    expect(splitFullName('Rohit')).toEqual({ firstName: 'Rohit', lastName: null });
  });

  it('survives extra spaces and an empty string', () => {
    expect(splitFullName('  Rohit   Kulkarni ')).toEqual({
      firstName: 'Rohit',
      lastName: 'Kulkarni',
    });
    expect(splitFullName('   ')).toEqual({ firstName: '', lastName: null });
  });
});

describe('the vocabulary', () => {
  it('names every channel a payload can arrive on, and every state it can be in', () => {
    expect(INGEST_CHANNELS).toContain('public_api');
    expect(INGEST_CHANNELS).toContain('form');
    // `received` first: it is the state the row is written in.
    expect(INBOUND_STATUSES[0]).toBe('received');
    expect(INGESTION_STAGES).toContain('normalize');
    expect(API_KEY_SCOPES).toEqual(['ingest:write', 'ingest:read']);
  });
});

describe('unmappedKeys', () => {
  it('names the fields this API does not know, rather than counting them', () => {
    expect(
      unmappedKeys({ phone: '1', propertyType: 'Apartment', budget_band: 'A', utm: {} }),
    ).toEqual(['propertyType', 'budget_band']);
  });

  it('answers nothing for a payload that is entirely understood', () => {
    expect(unmappedKeys({ name: 'Rohit', phone: '1', customFields: {}, metadata: {} })).toEqual([]);
  });
});

describe('customFieldKeyFor', () => {
  it('derives the key a one-click field would take from an integrator’s own spelling', () => {
    expect(customFieldKeyFor('propertyType')).toBe('property_type');
    expect(customFieldKeyFor('Budget Band')).toBe('budget_band');
    expect(customFieldKeyFor('utm-term')).toBe('utm_term');
    expect(customFieldKeyFor('possession_quarter')).toBe('possession_quarter');
  });

  it('only ever derives a key the field builder would accept', () => {
    for (const name of ['propertyType', 'Budget Band', 'agent code', 'leadScore2']) {
      const key = customFieldKeyFor(name);
      expect(key).not.toBeNull();
      expect(isValidCustomFieldKey(key as string)).toBe(true);
    }
  });

  it('refuses a name that collides with a lead’s own column', () => {
    // Otherwise the mapper would look for a `phone` custom field and the button would offer to
    // create one, which the API refuses — and neither could ever work.
    expect(customFieldKeyFor('phone')).toBeNull();
    expect(customFieldKeyFor('Source')).toBeNull();
  });

  it('refuses what cannot be a key at all rather than guessing', () => {
    expect(customFieldKeyFor('2ndPhone')).toBeNull();
    expect(customFieldKeyFor('   ')).toBeNull();
    expect(customFieldKeyFor('x')).toBeNull();
  });

  it('is the derivation the mapper and the button both use', () => {
    // The point of this function existing: a key derived one way in the web app and another way in
    // the mapper is a field somebody creates that nothing ever writes to.
    const sent = { propertyType: 'Apartment' };
    const extras = unmappedKeys(sent);
    expect(extras.map((key) => customFieldKeyFor(key))).toEqual(['property_type']);
  });
});
