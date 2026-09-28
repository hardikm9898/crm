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

describe('layer 3 — the CRM core cannot reference across tenants either', () => {
  /**
   * Every one of these uses the UNSCOPED client on purpose: the scoping extension already stops
   * them, so what is being proved is that the *database* stops them too. That is the layer that
   * survives an application bug (docs/security.md §3, layer 3).
   */
  it('blocks a lead pointing at another tenant status', async () => {
    await expect(
      h.unscoped.lead.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          fullName: 'Cross-tenant status',
          statusId: h.orgB.statusId,
          pipelineId: h.orgA.pipelineId,
          stageId: h.orgA.stageId,
        },
      }),
    ).rejects.toThrow(/leads_status_same_org_fk|foreign key/i);
  });

  it('blocks a lead pointing at another tenant pipeline', async () => {
    await expect(
      h.unscoped.lead.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          fullName: 'Cross-tenant pipeline',
          statusId: h.orgA.statusId,
          pipelineId: h.orgB.pipelineId,
          stageId: h.orgB.stageId,
        },
      }),
    ).rejects.toThrow(/leads_pipeline_same_org_fk|leads_stage|foreign key/i);
  });

  it('blocks a lead in a stage belonging to a different pipeline of the SAME tenant', async () => {
    // Not a tenancy bug but a correctness one: a lead in a column that is not on its board makes
    // the kanban lie. The composite FK on (organization_id, pipeline_id, stage_id) catches it.
    const otherPipelineId = newId();
    const otherStageId = newId();
    await h.unscoped.pipeline.create({
      data: {
        id: otherPipelineId,
        organizationId: h.orgA.organizationId,
        name: `Other ${newId().slice(0, 8)}`,
        entityType: 'lead',
      },
    });
    await h.unscoped.pipelineStage.create({
      data: {
        id: otherStageId,
        organizationId: h.orgA.organizationId,
        pipelineId: otherPipelineId,
        name: 'Elsewhere',
        sortOrder: 0,
      },
    });

    await expect(
      h.unscoped.lead.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          fullName: 'Wrong column',
          statusId: h.orgA.statusId,
          pipelineId: h.orgA.pipelineId,
          stageId: otherStageId,
        },
      }),
    ).rejects.toThrow(/leads_stage_in_pipeline_fk|foreign key/i);

    await h.unscoped.pipelineStage.delete({ where: { id: otherStageId } });
    await h.unscoped.pipeline.delete({ where: { id: otherPipelineId } });
  });

  it('blocks a tag applied to another tenant lead', async () => {
    const tagId = newId();
    await h.unscoped.tag.create({
      data: { id: tagId, organizationId: h.orgA.organizationId, name: `t-${tagId.slice(0, 8)}` },
    });
    await expect(
      h.unscoped.leadTag.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgB.leadId,
          tagId,
        },
      }),
    ).rejects.toThrow(/lead_tags_lead_same_org_fk|foreign key/i);
    await h.unscoped.tag.delete({ where: { id: tagId } });
  });

  it('blocks a custom field option pointing at another tenant definition', async () => {
    const definitionId = newId();
    await h.unscoped.customFieldDefinition.create({
      data: {
        id: definitionId,
        organizationId: h.orgB.organizationId,
        entityType: 'lead',
        key: 'orgb_only',
        label: 'Org B only',
        type: 'select',
      },
    });
    await expect(
      h.unscoped.customFieldOption.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          definitionId,
          value: 'x',
          label: 'X',
        },
      }),
    ).rejects.toThrow(/custom_field_options_definition_same_org_fk|foreign key/i);
    await h.unscoped.customFieldDefinition.delete({ where: { id: definitionId } });
  });

  it('blocks a touchpoint attached to another tenant lead', async () => {
    await expect(
      h.unscoped.leadTouchpoint.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgB.leadId,
          sequence: 1,
          occurredAt: new Date(),
          channel: 'manual',
        },
      }),
    ).rejects.toThrow(/lead_touchpoints_lead_same_org_fk|foreign key/i);
  });
});

describe('layer 3 — duplicates and assignment cannot reference across tenants either', () => {
  /**
   * The registry check catches an unregistered model; it cannot catch a missing composite FK. So
   * every table added in Phase 2 step 2 gets its own attempt here, made with the UNSCOPED client,
   * proving the database refuses what the extension would have refused anyway.
   */
  async function duplicateRuleFor(organizationId: string): Promise<string> {
    const id = newId();
    await h.unscoped.duplicateRule.create({
      data: {
        id,
        organizationId,
        name: `rule-${id.slice(0, 8)}`,
        matchOn: [['phoneE164']] as never,
      },
    });
    return id;
  }

  it('blocks a duplicate pair whose newer lead belongs to another tenant', async () => {
    const ruleId = await duplicateRuleFor(h.orgA.organizationId);
    await expect(
      h.unscoped.leadDuplicate.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          duplicateLeadId: h.orgB.leadId,
          ruleId,
          confidence: 90,
        },
      }),
    ).rejects.toThrow(/lead_duplicates_candidate_same_org_fk|foreign key/i);
    await h.unscoped.duplicateRule.delete({ where: { id: ruleId } });
  });

  it('blocks a duplicate pair scored by another tenant rule', async () => {
    const ruleId = await duplicateRuleFor(h.orgB.organizationId);
    await expect(
      h.unscoped.leadDuplicate.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          duplicateLeadId: h.orgA.leadId,
          ruleId,
          confidence: 90,
        },
      }),
    ).rejects.toThrow(
      /lead_duplicates_rule_same_org_fk|lead_duplicates_distinct_pair|foreign key/i,
    );
    await h.unscoped.duplicateRule.delete({ where: { id: ruleId } });
  });

  it('refuses to record a lead as a duplicate of itself', async () => {
    // A self-pair is not a tenancy bug but it would make the triage queue nonsense, and the merge
    // screen would offer someone the chance to merge a record into itself.
    const ruleId = await duplicateRuleFor(h.orgA.organizationId);
    await expect(
      h.unscoped.leadDuplicate.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          duplicateLeadId: h.orgA.leadId,
          ruleId,
          confidence: 50,
        },
      }),
    ).rejects.toThrow(/lead_duplicates_distinct_pair/i);
    await h.unscoped.duplicateRule.delete({ where: { id: ruleId } });
  });

  it('blocks a merge that absorbs another tenant lead', async () => {
    await expect(
      h.unscoped.leadMerge.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          survivingLeadId: h.orgA.leadId,
          mergedLeadId: h.orgB.leadId,
          performedById: h.orgA.userId,
        },
      }),
    ).rejects.toThrow(/lead_merges_absorbed_same_org_fk|foreign key/i);
  });

  it('allows one standing merge per absorbed lead, and another only after an undo', async () => {
    // The uniqueness is partial (`WHERE undone_at IS NULL`) so a lead that was merged, restored and
    // merged again is representable — which a plain unique index would have made impossible.
    const absorbedId = newId();
    await h.unscoped.lead.create({
      data: {
        id: absorbedId,
        organizationId: h.orgA.organizationId,
        fullName: 'Absorbed twice',
        statusId: h.orgA.statusId,
        pipelineId: h.orgA.pipelineId,
        stageId: h.orgA.stageId,
      },
    });
    const firstMergeId = newId();
    await h.unscoped.leadMerge.create({
      data: {
        id: firstMergeId,
        organizationId: h.orgA.organizationId,
        survivingLeadId: h.orgA.leadId,
        mergedLeadId: absorbedId,
        performedById: h.orgA.userId,
      },
    });

    await expect(
      h.unscoped.leadMerge.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          survivingLeadId: h.orgA.leadId,
          mergedLeadId: absorbedId,
          performedById: h.orgA.userId,
        },
      }),
    ).rejects.toThrow(/lead_merges_one_standing_per_merged_lead|unique/i);

    await h.unscoped.leadMerge.update({
      where: { id: firstMergeId },
      data: { undoneAt: new Date() },
    });
    const secondMergeId = newId();
    await h.unscoped.leadMerge.create({
      data: {
        id: secondMergeId,
        organizationId: h.orgA.organizationId,
        survivingLeadId: h.orgA.leadId,
        mergedLeadId: absorbedId,
        performedById: h.orgA.userId,
      },
    });

    await h.unscoped.leadMerge.deleteMany({ where: { mergedLeadId: absorbedId } });
    await h.unscoped.lead.delete({ where: { id: absorbedId } });
  });

  it('blocks a pool member who is a member of another tenant', async () => {
    const ruleId = newId();
    await h.unscoped.assignmentRule.create({
      data: {
        id: ruleId,
        organizationId: h.orgA.organizationId,
        name: `pool-${ruleId.slice(0, 8)}`,
        strategy: 'round_robin',
      },
    });
    await expect(
      h.unscoped.assignmentPoolMember.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          ruleId,
          // The FK is to `memberships(organization_id, user_id)`, not to `users`: a person is only
          // assignable where they are a member, which is the whole reason for that composite.
          userId: h.orgB.userId,
        },
      }),
    ).rejects.toThrow(/assignment_pool_members_membership_same_org_fk|foreign key/i);
    await h.unscoped.assignmentRule.delete({ where: { id: ruleId } });
  });

  it('blocks a condition and a rotation cursor attached to another tenant rule', async () => {
    const ruleId = newId();
    await h.unscoped.assignmentRule.create({
      data: {
        id: ruleId,
        organizationId: h.orgB.organizationId,
        name: `orgb-${ruleId.slice(0, 8)}`,
        strategy: 'round_robin',
      },
    });

    await expect(
      h.unscoped.assignmentRuleCondition.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          ruleId,
          fieldPath: 'city',
          operator: 'eq',
          value: 'Pune' as never,
        },
      }),
    ).rejects.toThrow(/assignment_rule_conditions_rule_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.roundRobinState.create({
        data: { id: newId(), organizationId: h.orgA.organizationId, ruleId },
      }),
    ).rejects.toThrow(/round_robin_state_rule_same_org_fk|foreign key/i);

    await h.unscoped.assignmentRule.delete({ where: { id: ruleId } });
  });

  it('blocks a lead pointing at another tenant lead as its duplicate or merge target', async () => {
    // Both are self-referential composite FKs on `leads`, which is the case easiest to get wrong:
    // a plain FK to `leads(id)` would have allowed either.
    await expect(
      h.unscoped.lead.update({
        where: { id: h.orgA.leadId },
        data: { isDuplicateOfId: h.orgB.leadId },
      }),
    ).rejects.toThrow(/leads_duplicate_of_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.lead.update({
        where: { id: h.orgA.leadId },
        data: { mergedIntoId: h.orgB.leadId },
      }),
    ).rejects.toThrow(/leads_merged_into_same_org_fk|foreign key/i);
  });

  it('refuses to point a lead at itself', async () => {
    await expect(
      h.unscoped.lead.update({
        where: { id: h.orgA.leadId },
        data: { mergedIntoId: h.orgA.leadId },
      }),
    ).rejects.toThrow(/leads_not_own_merge_target/i);
  });
});

describe('layer 2 — the CRM models are scoped like every other tenant table', () => {
  it('shows each tenant only its own leads', async () => {
    const a = await tenantContext.run(h.orgA.principal, async () => h.db.lead.findMany({}));
    const b = await tenantContext.run(h.orgB.principal, async () => h.db.lead.findMany({}));
    expect(a.every((lead) => lead.organizationId === h.orgA.organizationId)).toBe(true);
    expect(b.every((lead) => lead.organizationId === h.orgB.organizationId)).toBe(true);
    expect(a.some((lead) => lead.id === h.orgB.leadId)).toBe(false);
  });

  it('returns null for another tenant lead addressed by primary key', async () => {
    const found = await tenantContext.run(h.orgA.principal, async () =>
      h.db.lead.findUnique({ where: { id: h.orgB.leadId } }),
    );
    expect(found).toBeNull();
  });

  it('scopes the partitioned activities table too', async () => {
    const occurredAt = new Date();
    await tenantContext.run(h.orgA.principal, async () =>
      h.db.activity.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          type: 'lead.created',
          occurredAt,
        },
      }),
    );
    const seenByB = await tenantContext.run(h.orgB.principal, async () =>
      h.db.activity.findMany({}),
    );
    // Partitioning changes the storage, not the isolation.
    expect(seenByB.every((entry) => entry.organizationId === h.orgB.organizationId)).toBe(true);
  });

  it('refuses a lead read with no tenant context at all', async () => {
    await expect(h.db.lead.findMany({})).rejects.toThrow(/No tenant context/);
  });
});
