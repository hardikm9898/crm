import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, tenantContext, withPlatformScope } from '@leados/shared';
import { CrossTenantAccessError } from './tenant-scope.js';
import { createHarness, type TestHarness } from './testing/fixtures.js';
import { assertTenantRegistryComplete } from './registry-check.js';
import { Prisma } from '../generated/prisma/client.js';

/**
 * THE ISOLATION SUITE.
 *
 * The highest-severity class of bug in this product is one tenant reading another
 * tenant's data (NFR-SEC-1). These tests exercise all four defence layers from
 * docs/security.md §3 against a real PostgreSQL database — layer 3 in particular
 * cannot be tested with a mock, because the whole point is that the DATABASE refuses.
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.dispose();
});

describe('layer 1+2 — no tenant context means refusal, not a wide-open query', () => {
  it('refuses a read outside any tenant context', async () => {
    await expect(h.db.team.findMany({})).rejects.toThrow(/No tenant context/);
  });

  it('refuses a write outside any tenant context', async () => {
    await expect(
      h.db.team.create({ data: { id: newId(), name: 'orphan' } as never }),
    ).rejects.toThrow(/No tenant context/);
  });

  it('refuses a count outside any tenant context', async () => {
    await expect(h.db.membership.count()).rejects.toThrow(/No tenant context/);
  });

  it('names the model and operation so the failure is debuggable', async () => {
    await expect(h.db.role.findMany({})).rejects.toThrow(/Role\.findMany/);
  });
});

describe('layer 2 — reads are scoped to the active organization', () => {
  it('sees only its own rows even with no explicit filter', async () => {
    const seenByA = await tenantContext.run(h.orgA.principal, async () => h.db.team.findMany({}));
    const seenByB = await tenantContext.run(h.orgB.principal, async () => h.db.team.findMany({}));

    expect(seenByA.map((t) => t.id)).toEqual([h.orgA.teamId]);
    expect(seenByB.map((t) => t.id)).toEqual([h.orgB.teamId]);
  });

  it('returns null for another tenant row addressed by primary key (IDOR defence)', async () => {
    const found = await tenantContext.run(h.orgA.principal, async () =>
      h.db.team.findUnique({ where: { id: h.orgB.teamId } }),
    );
    expect(found).toBeNull();
  });

  it('findFirst cannot be steered to another tenant', async () => {
    const found = await tenantContext.run(h.orgA.principal, async () =>
      h.db.branch.findFirst({ where: { id: h.orgB.branchId } }),
    );
    expect(found).toBeNull();
  });

  it('counts only its own rows', async () => {
    const count = await tenantContext.run(h.orgA.principal, async () => h.db.branch.count());
    expect(count).toBe(1);
  });

  it('scopes the Organization model by its own primary key', async () => {
    const own = await tenantContext.run(h.orgA.principal, async () =>
      h.db.organization.findMany({}),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.id).toBe(h.orgA.organizationId);
  });
});

describe('layer 2 — writes cannot escape the active organization', () => {
  it('stamps organizationId on create, ignoring what the caller omitted', async () => {
    const teamId = newId();
    await tenantContext.run(h.orgA.principal, async () => {
      await h.db.team.create({ data: { id: teamId, name: 'Scoped team' } as never });
    });

    const row = await h.unscoped.team.findUniqueOrThrow({ where: { id: teamId } });
    expect(row.organizationId).toBe(h.orgA.organizationId);
  });

  it('rejects a create that explicitly names another organization', async () => {
    await tenantContext.run(h.orgA.principal, async () => {
      await expect(
        h.db.team.create({
          data: { id: newId(), name: 'smuggled', organizationId: h.orgB.organizationId } as never,
        }),
      ).rejects.toThrow(CrossTenantAccessError);
    });
  });

  it('rejects a read that explicitly names another organization', async () => {
    await tenantContext.run(h.orgA.principal, async () => {
      await expect(
        h.db.team.findMany({ where: { organizationId: h.orgB.organizationId } }),
      ).rejects.toThrow(CrossTenantAccessError);
    });
  });

  it('cannot update another tenant row by id', async () => {
    await tenantContext.run(h.orgA.principal, async () => {
      await expect(
        h.db.team.update({ where: { id: h.orgB.teamId }, data: { name: 'hijacked' } }),
      ).rejects.toThrow();
    });

    const untouched = await h.unscoped.team.findUniqueOrThrow({ where: { id: h.orgB.teamId } });
    expect(untouched.name).toBe('Team');
  });

  it('deleteMany with no filter deletes only the active tenant rows', async () => {
    const throwawayA = newId();
    const throwawayB = newId();
    await h.unscoped.holiday.createMany({
      data: [
        {
          id: throwawayA,
          organizationId: h.orgA.organizationId,
          date: new Date('2026-01-26'),
          name: 'A holiday',
        },
        {
          id: throwawayB,
          organizationId: h.orgB.organizationId,
          date: new Date('2026-01-26'),
          name: 'B holiday',
        },
      ],
    });

    const deleted = await tenantContext.run(h.orgA.principal, async () =>
      h.db.holiday.deleteMany({}),
    );
    expect(deleted.count).toBe(1);

    expect(await h.unscoped.holiday.findUnique({ where: { id: throwawayA } })).toBeNull();
    expect(await h.unscoped.holiday.findUnique({ where: { id: throwawayB } })).not.toBeNull();

    await h.unscoped.holiday.delete({ where: { id: throwawayB } });
  });
});

describe('layer 3 — the database refuses cross-tenant references even when the extension is bypassed', () => {
  it('blocks a team pointing at another tenant branch', async () => {
    // Deliberately using the UNSCOPED client: this is the "application bug" scenario.
    await expect(
      h.unscoped.team.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          branchId: h.orgB.branchId,
          name: 'cross-tenant team',
        },
      }),
    ).rejects.toThrow(/teams_branch_same_org_fk|foreign key/i);
  });

  it('blocks a team member whose membership belongs to another tenant', async () => {
    await expect(
      h.unscoped.teamMember.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          teamId: h.orgA.teamId,
          userId: h.orgB.userId, // a real user, but not a member of org A
        },
      }),
    ).rejects.toThrow(/team_members_membership_same_org_fk|foreign key/i);
  });

  it('blocks a role grant pointing at another tenant role', async () => {
    await expect(
      h.unscoped.userRole.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          userId: h.orgA.userId,
          roleId: h.orgB.roleId,
        },
      }),
    ).rejects.toThrow(/user_roles_role_same_org_fk|foreign key/i);
  });

  it('allows the same reference within one tenant', async () => {
    const id = newId();
    await h.unscoped.team.create({
      data: {
        id,
        organizationId: h.orgA.organizationId,
        branchId: h.orgA.branchId,
        name: 'valid team',
      },
    });
    expect((await h.unscoped.team.findUniqueOrThrow({ where: { id } })).branchId).toBe(
      h.orgA.branchId,
    );
    await h.unscoped.team.delete({ where: { id } });
  });
});

describe('platform scope — the escape hatch is explicit and bounded', () => {
  it('reads across tenants only inside withPlatformScope', async () => {
    const all = await withPlatformScope('isolation suite: platform read', async () =>
      h.db.team.findMany({ where: { id: { in: [h.orgA.teamId, h.orgB.teamId] } } }),
    );
    expect(all).toHaveLength(2);
  });

  it('reverts to scoped behaviour after the platform block ends', async () => {
    await withPlatformScope('isolation suite', async () => h.db.team.count());
    await expect(h.db.team.findMany({})).rejects.toThrow(/No tenant context/);
  });
});

describe('concurrency — interleaved tenants never cross over', () => {
  it('keeps 40 interleaved requests from two tenants correctly scoped', async () => {
    const work = Array.from({ length: 40 }, (_, index) => {
      const tenant = index % 2 === 0 ? h.orgA : h.orgB;
      return tenantContext.run(tenant.principal, async () => {
        // A deliberate await before the query, so the contexts genuinely interleave.
        await new Promise((resolve) => setTimeout(resolve, index % 7));
        const rows = await h.db.branch.findMany({});
        return { expected: tenant.organizationId, actual: rows.map((r) => r.organizationId) };
      });
    });

    const results = await Promise.all(work);
    for (const result of results) {
      expect(result.actual).toEqual([result.expected]);
    }
  });
});

describe('transactions', () => {
  it('applies scoping inside an interactive transaction', async () => {
    const teamId = newId();
    await tenantContext.run(h.orgA.principal, async () => {
      await h.db.$transaction(async (tx) => {
        await tx.team.create({ data: { id: teamId, name: 'tx team' } as never });
        const inside = await tx.team.findMany({});
        expect(inside.every((t) => t.organizationId === h.orgA.organizationId)).toBe(true);
      });
    });
    const row = await h.unscoped.team.findUniqueOrThrow({ where: { id: teamId } });
    expect(row.organizationId).toBe(h.orgA.organizationId);
    await h.unscoped.team.delete({ where: { id: teamId } });
  });

  it('rolls the whole transaction back on failure, leaving no partial tenant state', async () => {
    const teamId = newId();
    await tenantContext.run(h.orgA.principal, async () => {
      await expect(
        h.db.$transaction(async (tx) => {
          await tx.team.create({ data: { id: teamId, name: 'doomed' } as never });
          throw new Error('deliberate failure');
        }),
      ).rejects.toThrow('deliberate failure');
    });
    expect(await h.unscoped.team.findUnique({ where: { id: teamId } })).toBeNull();
  });
});

describe('registry completeness — isolation cannot be forgotten for a new model', () => {
  it('every model carrying organizationId is registered as tenant-scoped', () => {
    const models = Object.values(Prisma.ModelName).map((name) => {
      const fieldEnum = (Prisma as unknown as Record<string, Record<string, string>>)[
        `${name}ScalarFieldEnum`
      ];
      return { name, fields: Object.keys(fieldEnum ?? {}).map((field) => ({ name: field })) };
    });

    expect(models.length).toBeGreaterThan(15);
    expect(() => assertTenantRegistryComplete(models)).not.toThrow();
  });
});

describe('append-only audit log (FR-AUD-2)', () => {
  it('accepts inserts', async () => {
    const id = newId();
    await tenantContext.run(h.orgA.principal, async () => {
      await h.db.auditLog.create({
        data: {
          id,
          actorType: 'user',
          actorId: h.orgA.userId,
          action: 'test.performed',
          resourceType: 'team',
          resourceId: h.orgA.teamId,
        } as never,
      });
    });
    expect(await h.unscoped.auditLog.findUnique({ where: { id } })).not.toBeNull();
  });

  it('rejects UPDATE at the database level', async () => {
    const row = await h.unscoped.auditLog.findFirstOrThrow({
      where: { organizationId: h.orgA.organizationId },
    });
    await expect(
      h.unscoped.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects DELETE at the database level', async () => {
    const row = await h.unscoped.auditLog.findFirstOrThrow({
      where: { organizationId: h.orgA.organizationId },
    });
    await expect(h.unscoped.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/i,
    );
  });
});
