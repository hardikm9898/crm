import { describe, expect, it } from 'vitest';
import { tenantContext, type DataScope, type TenantPrincipal } from '@leados/shared';
import { DataScopeService, applyScopeFilter } from './data-scope.service.js';

const service = new DataScopeService();

const LEAD_COLUMNS = {
  userColumn: 'assignedUserId',
  teamColumn: 'teamId',
  branchColumn: 'branchId',
};

function principal(scope: DataScope, overrides: Partial<TenantPrincipal> = {}): TenantPrincipal {
  return {
    organizationId: 'org-1',
    actorType: 'user',
    actorId: 'user-1',
    permissions: new Set(['lead:read']),
    scopes: new Map([['lead:read', scope]]),
    teamIds: ['team-1', 'team-2'],
    branchIds: ['branch-1'],
    requestId: 'req-1',
    ...overrides,
  };
}

const run = <T>(p: TenantPrincipal, fn: () => T): Promise<T> =>
  tenantContext.run(p, async () => fn());

describe('DataScopeService.filterFor', () => {
  it('organization scope imposes no extra predicate', async () => {
    const filter = await run(principal('organization'), () =>
      service.filterFor('lead:read', LEAD_COLUMNS),
    );
    expect(filter).toEqual({ kind: 'all' });
  });

  it('own scope narrows to rows the caller owns', async () => {
    const filter = await run(principal('own'), () => service.filterFor('lead:read', LEAD_COLUMNS));
    expect(filter).toEqual({ kind: 'where', where: { assignedUserId: 'user-1' } });
  });

  it('branch scope narrows to the caller’s branches', async () => {
    const filter = await run(principal('branch'), () =>
      service.filterFor('lead:read', LEAD_COLUMNS),
    );
    expect(filter).toEqual({ kind: 'where', where: { branchId: { in: ['branch-1'] } } });
  });

  it('team scope includes the caller’s teams and their own unassigned rows', async () => {
    const filter = await run(principal('team'), () => service.filterFor('lead:read', LEAD_COLUMNS));
    expect(filter).toEqual({
      kind: 'where',
      where: { OR: [{ teamId: { in: ['team-1', 'team-2'] } }, { assignedUserId: 'user-1' }] },
    });
  });

  it('narrows rather than widens when a scope cannot be satisfied', async () => {
    // Branch-scoped but assigned to no branch: seeing everything would be a silent widening.
    const noBranch = await run(principal('branch', { branchIds: [] }), () =>
      service.filterFor('lead:read', LEAD_COLUMNS),
    );
    expect(noBranch).toEqual({ kind: 'where', where: { assignedUserId: 'user-1' } });

    const noTeam = await run(principal('team', { teamIds: [] }), () =>
      service.filterFor('lead:read', LEAD_COLUMNS),
    );
    expect(noTeam).toEqual({ kind: 'where', where: { assignedUserId: 'user-1' } });
  });

  it('matches nothing when the entity has no ownership column and the scope is own', async () => {
    // "Own" is meaningless without an owner column, so the safe reading is an empty result.
    const filter = await run(principal('own'), () => service.filterFor('lead:read', {}));
    expect(filter).toEqual({ kind: 'none' });
  });

  it('defaults to the narrowest scope when a grant records none', async () => {
    const filter = await run(principal('own', { scopes: new Map() }), () =>
      service.filterFor('lead:read', LEAD_COLUMNS),
    );
    expect(filter).toEqual({ kind: 'where', where: { assignedUserId: 'user-1' } });
  });

  it('refuses when the caller lacks the permission entirely', async () => {
    await expect(
      run(principal('organization', { permissions: new Set() }), () =>
        service.filterFor('lead:read', LEAD_COLUMNS),
      ),
    ).rejects.toThrow(/Missing permission: lead:read/);
  });

  it('refuses outside a tenant context', () => {
    expect(() => service.filterFor('lead:read', LEAD_COLUMNS)).toThrow(/No tenant context/);
  });
});

describe('DataScopeService.canAct (single-row authority)', () => {
  it('organization scope may act on any row in the tenant', async () => {
    const allowed = await run(principal('organization'), () =>
      service.canAct('lead:read', {
        userId: 'someone-else',
        teamId: 'team-9',
        branchId: 'branch-9',
      }),
    );
    expect(allowed).toBe(true);
  });

  it('own scope may act only on their own row — knowing an id is not authority', async () => {
    await run(principal('own'), () => {
      expect(service.canAct('lead:read', { userId: 'user-1' })).toBe(true);
      expect(service.canAct('lead:read', { userId: 'user-2' })).toBe(false);
    });
  });

  it('team scope covers teammates’ rows and their own', async () => {
    await run(principal('team'), () => {
      expect(service.canAct('lead:read', { teamId: 'team-2', userId: 'user-9' })).toBe(true);
      expect(service.canAct('lead:read', { teamId: 'team-9', userId: 'user-9' })).toBe(false);
      expect(service.canAct('lead:read', { teamId: 'team-9', userId: 'user-1' })).toBe(true);
    });
  });

  it('branch scope covers their branch, and falls back to ownership for unassigned rows', async () => {
    await run(principal('branch'), () => {
      expect(service.canAct('lead:read', { branchId: 'branch-1' })).toBe(true);
      expect(service.canAct('lead:read', { branchId: 'branch-9' })).toBe(false);
      expect(service.canAct('lead:read', { branchId: null, userId: 'user-1' })).toBe(true);
      expect(service.canAct('lead:read', { branchId: null, userId: 'user-2' })).toBe(false);
    });
  });

  it('returns false rather than throwing when the permission is missing', async () => {
    const allowed = await run(principal('organization', { permissions: new Set() }), () =>
      service.canAct('lead:read', { userId: 'user-1' }),
    );
    expect(allowed).toBe(false);
  });
});

describe('applyScopeFilter', () => {
  it('merges a predicate into an existing where', () => {
    expect(
      applyScopeFilter({ deletedAt: null }, { kind: 'where', where: { assignedUserId: 'u1' } }),
    ).toEqual({ deletedAt: null, assignedUserId: 'u1' });
  });

  it('passes the where through unchanged for organization scope', () => {
    expect(applyScopeFilter({ deletedAt: null }, { kind: 'all' })).toEqual({ deletedAt: null });
  });

  it('signals an impossible query with null, so callers cannot accidentally query everything', () => {
    expect(applyScopeFilter({ deletedAt: null }, { kind: 'none' })).toBeNull();
  });
});
