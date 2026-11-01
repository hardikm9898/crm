import { describe, expect, it } from 'vitest';
import {
  API_GRANTABLE_PERMISSIONS,
  API_KEY_SCOPES,
  API_LOG_RETENTION_DAYS,
  INGESTION_SCOPES,
  PERMISSION_CATALOGUE,
  credentialMessage,
  describeDuration,
  isApiKeyScope,
  isIngestionScope,
  logPath,
  looksLikeApiCredential,
  parseApiCredential,
  restPermissionsOf,
  statusClass,
} from './index.js';

describe('the scopes a key may hold', () => {
  it('is the two ingestion scopes plus permission keys, and nothing invented', () => {
    expect(API_KEY_SCOPES.slice(0, 2)).toEqual([...INGESTION_SCOPES]);
    const known = new Set(PERMISSION_CATALOGUE.map((entry) => entry.key));
    for (const permission of API_GRANTABLE_PERMISSIONS) {
      // A scope the permission guard has never heard of is a tick box that grants nothing.
      expect(known.has(permission), permission).toBe(true);
    }
  });

  it('withholds every permission that administers access, money or credentials', () => {
    const granted = new Set<string>(API_GRANTABLE_PERMISSIONS);
    for (const withheld of [
      'role:manage',
      'user:manage',
      'api_key:manage',
      'webhook:manage',
      'billing:manage',
      'organization:manage',
      'privacy:manage',
      'export:pii',
    ]) {
      expect(granted.has(withheld), withheld).toBe(false);
    }
  });

  it('grants nothing a system role template does not also know', () => {
    // The owner template grants the whole catalogue, so a key's scope is always something a person
    // could hold too: a key is never a way to reach an action no role describes.
    const known = new Set(PERMISSION_CATALOGUE.map((entry) => entry.key));
    expect(API_GRANTABLE_PERMISSIONS.every((key) => known.has(key))).toBe(true);
  });

  it('recognises its own entries and refuses anything else', () => {
    expect(isApiKeyScope('ingest:write')).toBe(true);
    expect(isApiKeyScope('lead:read')).toBe(true);
    expect(isApiKeyScope('role:manage')).toBe(false);
    expect(isApiKeyScope('lead:read ')).toBe(false);
    expect(isApiKeyScope('')).toBe(false);
  });

  it('separates the ingestion scopes from the permissions the REST surface enforces', () => {
    const scopes = ['ingest:write', 'lead:read', 'task:manage'];
    expect(restPermissionsOf(scopes)).toEqual(['lead:read', 'task:manage']);
    expect(scopes.filter(isIngestionScope)).toEqual(['ingest:write']);
  });

  it('drops a stored scope that is no longer grantable rather than trusting it', () => {
    // A key written before a permission was withdrawn must not keep it: the row is data, and the
    // list in code is the decision.
    expect(restPermissionsOf(['lead:read', 'role:manage'])).toEqual(['lead:read']);
  });
});

describe('the credential header', () => {
  it('reads the documented form', () => {
    const parsed = parseApiCredential('Bearer pk_live_abc123.sk_live_def456');
    expect(parsed).toEqual({
      ok: true,
      credential: { keyId: 'pk_live_abc123', secret: 'sk_live_def456' },
    });
  });

  it('is case-insensitive about the scheme and tolerant of extra spaces', () => {
    const parsed = parseApiCredential('bearer   pk_live_a.sk_live_b');
    expect(parsed.ok).toBe(true);
  });

  it('refuses a missing header, a bare token, and the halves the wrong way round', () => {
    expect(parseApiCredential(undefined)).toEqual({ ok: false, failure: 'missing' });
    expect(parseApiCredential('Bearer ')).toEqual({ ok: false, failure: 'missing' });
    expect(parseApiCredential('pk_live_a.sk_live_b')).toEqual({ ok: false, failure: 'missing' });
    expect(parseApiCredential('Bearer pk_live_a')).toEqual({ ok: false, failure: 'malformed' });
    expect(parseApiCredential('Bearer sk_live_b.pk_live_a')).toEqual({
      ok: false,
      failure: 'malformed',
    });
    expect(parseApiCredential('Bearer .sk_live_b')).toEqual({ ok: false, failure: 'malformed' });
  });

  it('keeps a secret containing the separator whole', () => {
    // Split on the *first* dot only: the id half cannot contain one, the secret half might.
    const parsed = parseApiCredential('Bearer pk_live_a.sk_live_b.c.d');
    expect(parsed.ok && parsed.credential.secret).toBe('sk_live_b.c.d');
  });

  it('tells a key apart from an access token by shape, not by trying one', () => {
    expect(looksLikeApiCredential('Bearer pk_live_a.sk_live_b')).toBe(true);
    expect(looksLikeApiCredential('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig')).toBe(false);
    expect(looksLikeApiCredential(undefined)).toBe(false);
  });

  it('says what to send, in both refusals', () => {
    expect(credentialMessage('missing')).toMatch(/Authorization: Bearer/);
    expect(credentialMessage('malformed')).toMatch(/pk_live_/);
  });
});

describe('what a log row says', () => {
  it('stores the path and never the query string', () => {
    expect(logPath('/api/v1/leads?f=name:contains:asha&limit=50')).toBe('/api/v1/leads');
    expect(logPath('/api/v1/leads')).toBe('/api/v1/leads');
  });

  it('bounds a path somebody made very long', () => {
    expect(logPath(`/api/v1/${'x'.repeat(900)}`)).toHaveLength(512);
  });

  it('groups a status the way a screen does', () => {
    expect(statusClass(200)).toBe('success');
    expect(statusClass(304)).toBe('success');
    expect(statusClass(401)).toBe('client_error');
    expect(statusClass(429)).toBe('client_error');
    expect(statusClass(500)).toBe('server_error');
    expect(statusClass(100)).toBe('other');
  });

  it('says a duration the way a person reads one', () => {
    expect(describeDuration(12)).toBe('12 ms');
    expect(describeDuration(999)).toBe('999 ms');
    expect(describeDuration(1400)).toBe('1.4 s');
  });

  it('keeps the retention window short enough to stay a debugging tool', () => {
    expect(API_LOG_RETENTION_DAYS).toBeLessThanOrEqual(90);
    expect(API_LOG_RETENTION_DAYS).toBeGreaterThanOrEqual(7);
  });
});
