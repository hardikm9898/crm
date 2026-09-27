import { describe, expect, it } from 'vitest';
import {
  TenantContextMissingError,
  systemPrincipal,
  tenantContext,
  withPlatformScope,
  type TenantPrincipal,
} from './tenant-context.js';

function principal(
  organizationId: string,
  overrides: Partial<TenantPrincipal> = {},
): TenantPrincipal {
  return {
    organizationId,
    actorType: 'user',
    actorId: 'user-1',
    permissions: new Set(['lead:read']),
    scopes: new Map([['lead:read', 'team']]),
    teamIds: ['team-1'],
    branchIds: [],
    requestId: 'req-1',
    ...overrides,
  };
}

describe('tenantContext', () => {
  it('has no principal outside a context', () => {
    expect(tenantContext.get()).toBeNull();
    expect(() => tenantContext.require('lead.findMany')).toThrow(TenantContextMissingError);
  });

  it('exposes the principal inside a context', async () => {
    await tenantContext.run(principal('org-a'), async () => {
      expect(tenantContext.organizationId('t')).toBe('org-a');
      expect(tenantContext.has('lead:read')).toBe(true);
      expect(tenantContext.has('lead:delete')).toBe(false);
      expect(tenantContext.scopeFor('lead:read')).toBe('team');
    });
  });

  it('does not leak the context after the scope ends', async () => {
    await tenantContext.run(principal('org-a'), async () => undefined);
    expect(tenantContext.get()).toBeNull();
  });

  it('keeps concurrent tenants isolated', async () => {
    const seen: string[] = [];
    const read = async (org: string, delay: number) =>
      tenantContext.run(principal(org), async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.push(tenantContext.organizationId('t'));
      });

    // Interleave deliberately: a slow org-a request must not observe org-b's context.
    await Promise.all([read('org-a', 20), read('org-b', 5), read('org-c', 10)]);
    expect(seen.sort()).toEqual(['org-a', 'org-b', 'org-c']);
  });

  it('survives nested async boundaries', async () => {
    await tenantContext.run(principal('org-a'), async () => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      const nested = await (async () => tenantContext.organizationId('t'))();
      expect(nested).toBe('org-a');
    });
  });

  it('propagates into nested runs without bleeding back out', async () => {
    await tenantContext.run(principal('org-a'), async () => {
      await tenantContext.run(principal('org-b'), async () => {
        expect(tenantContext.organizationId('t')).toBe('org-b');
      });
      expect(tenantContext.organizationId('t')).toBe('org-a');
    });
  });

  it('documents the lazy-promise trap: the context must be active at await time', async () => {
    // A non-async callback returns an unresolved thenable; by the time it is awaited
    // the ALS scope has already exited. This is exactly how a Prisma promise behaves,
    // so the scoped data layer would (correctly) refuse to run.
    const escaped = tenantContext.run(principal('org-a'), async () => {
      return () => tenantContext.get(); // deferred read, executed after the scope closes
    });
    const deferredRead = await escaped;
    expect(deferredRead()).toBeNull();
  });
});

describe('withPlatformScope', () => {
  it('marks the scope so the data layer can bypass tenant filtering', async () => {
    expect(tenantContext.isPlatformScope()).toBe(false);
    await withPlatformScope('outbox dispatcher', async () => {
      expect(tenantContext.isPlatformScope()).toBe(true);
    });
    expect(tenantContext.isPlatformScope()).toBe(false);
  });

  it('requires a reason, so every bypass is explainable in review', async () => {
    expect(() => withPlatformScope('', async () => undefined)).toThrow(/requires a reason/);
  });

  it('preserves an existing principal while widening scope', async () => {
    await tenantContext.run(principal('org-a'), async () => {
      await withPlatformScope('platform metrics', async () => {
        expect(tenantContext.get()?.organizationId).toBe('org-a');
        expect(tenantContext.isPlatformScope()).toBe(true);
      });
    });
  });
});

describe('systemPrincipal', () => {
  it('builds a principal for jobs with no user behind them', async () => {
    await tenantContext.run(systemPrincipal('org-a', 'job-1', ['lead:write']), async () => {
      expect(tenantContext.get()?.actorType).toBe('system');
      expect(tenantContext.has('lead:write')).toBe(true);
    });
  });
});
