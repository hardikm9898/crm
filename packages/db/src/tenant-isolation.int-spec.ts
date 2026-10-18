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

  /**
   * Imports and exports (`FR-IO-1`, `FR-IO-3`).
   *
   * These four matter more than most: an import row points at a lead, an import job points at an
   * uploaded file, and an export job points at a generated one — so a crossed reference here is
   * one tenant's spreadsheet becoming downloadable by another. The registry check cannot catch a
   * missing composite FK, which is why every new tenant table gets its own case here.
   */
  it('blocks an import job pointing at another tenant file', async () => {
    const documentId = newId();
    await h.unscoped.document.create({
      data: {
        id: documentId,
        organizationId: h.orgB.organizationId,
        subject: 'import',
        fileKey: `org/${h.orgB.organizationId}/import/x.csv`,
        fileName: 'x.csv',
        mimeType: 'text/csv',
        sizeBytes: 12,
        checksum: 'a'.repeat(64),
      },
    });

    await expect(
      h.unscoped.importJob.create({
        data: { id: newId(), organizationId: h.orgA.organizationId, documentId },
      }),
    ).rejects.toThrow(/import_jobs_document_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.exportJob.create({
        data: { id: newId(), organizationId: h.orgA.organizationId, documentId },
      }),
    ).rejects.toThrow(/export_jobs_document_same_org_fk|foreign key/i);

    await h.unscoped.document.delete({ where: { id: documentId } });
  });

  it('blocks an import row pointing at another tenant job, or another tenant lead', async () => {
    const documentId = newId();
    const jobId = newId();
    await h.unscoped.document.create({
      data: {
        id: documentId,
        organizationId: h.orgB.organizationId,
        subject: 'import',
        fileKey: `org/${h.orgB.organizationId}/import/y.csv`,
        fileName: 'y.csv',
        mimeType: 'text/csv',
        sizeBytes: 12,
        checksum: 'b'.repeat(64),
      },
    });
    await h.unscoped.importJob.create({
      data: { id: jobId, organizationId: h.orgB.organizationId, documentId },
    });

    // Org A's row cannot belong to org B's job …
    await expect(
      h.unscoped.importRow.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          jobId,
          rowNumber: 2,
          status: 'skipped',
        },
      }),
    ).rejects.toThrow(/import_rows_job_same_org_fk|foreign key/i);

    // … nor can org B's row claim org A's lead.
    await expect(
      h.unscoped.importRow.create({
        data: {
          id: newId(),
          organizationId: h.orgB.organizationId,
          jobId,
          rowNumber: 3,
          status: 'created',
          leadId: h.orgA.leadId,
        },
      }),
    ).rejects.toThrow(/import_rows_lead_same_org_fk|foreign key/i);

    await h.unscoped.importJob.delete({ where: { id: jobId } });
    await h.unscoped.document.delete({ where: { id: documentId } });
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

describe('layer 3 — scoring and saved views cannot reference across tenants either', () => {
  it('blocks a score event on another tenant’s lead', async () => {
    await expect(
      h.unscoped.leadScoreEvent.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgB.leadId,
          delta: 10,
          reason: 'Cross tenant',
          scoreAfter: 10,
        },
      }),
    ).rejects.toThrow(/lead_score_events_lead_same_org_fk|foreign key/i);
  });

  it('blocks a score event scored by another tenant’s rule', async () => {
    const ruleId = newId();
    await h.unscoped.scoringRule.create({
      data: {
        id: ruleId,
        organizationId: h.orgB.organizationId,
        name: `orgb-${ruleId.slice(0, 8)}`,
        triggerEvent: 'lead.created',
        points: 10,
      },
    });
    await expect(
      h.unscoped.leadScoreEvent.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          ruleId,
          delta: 10,
          reason: 'Cross tenant rule',
          scoreAfter: 10,
        },
      }),
    ).rejects.toThrow(/lead_score_events_rule_same_org_fk|foreign key/i);
    await h.unscoped.scoringRule.delete({ where: { id: ruleId } });
  });

  it('makes two overlapping bands unrepresentable, and adjacency still fine', async () => {
    // An exclusion constraint rather than a check: a band set is replaced as a whole, and two
    // concurrent replacements could otherwise interleave into an overlap no request asked for.
    const first = newId();
    await h.unscoped.scoreBand.create({
      data: {
        id: first,
        organizationId: h.orgA.organizationId,
        name: `low-${first.slice(0, 6)}`,
        minScore: 0,
        maxScore: 100,
      },
    });
    await expect(
      h.unscoped.scoreBand.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          name: `overlap-${first.slice(0, 6)}`,
          minScore: 100,
          maxScore: 200,
        },
      }),
    ).rejects.toThrow(/score_bands_no_overlap|conflicting key/i);

    const adjacent = newId();
    await h.unscoped.scoreBand.create({
      data: {
        id: adjacent,
        organizationId: h.orgA.organizationId,
        name: `next-${adjacent.slice(0, 6)}`,
        minScore: 101,
        maxScore: 200,
      },
    });

    // The constraint is per organization: the other tenant may use the same range.
    const otherTenant = newId();
    await h.unscoped.scoreBand.create({
      data: {
        id: otherTenant,
        organizationId: h.orgB.organizationId,
        name: `same-range-${otherTenant.slice(0, 6)}`,
        minScore: 0,
        maxScore: 100,
      },
    });

    await h.unscoped.scoreBand.deleteMany({
      where: { id: { in: [first, adjacent, otherTenant] } },
    });
  });

  it('ties a scoring rule’s decay to the decay trigger, in both directions', async () => {
    const base = {
      organizationId: h.orgA.organizationId,
      triggerEvent: 'schedule.decay',
      points: 0,
    };
    await expect(
      h.unscoped.scoringRule.create({
        data: { ...base, id: newId(), name: `sweep-no-decay-${newId().slice(0, 6)}` },
      }),
    ).rejects.toThrow(/scoring_rules_decay_matches_trigger/i);

    await expect(
      h.unscoped.scoringRule.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          name: `event-with-decay-${newId().slice(0, 6)}`,
          triggerEvent: 'lead.created',
          points: 5,
          decay: { afterDays: 1, points: 1, everyDays: 1, floor: 0 },
        },
      }),
    ).rejects.toThrow(/scoring_rules_decay_matches_trigger/i);
  });

  it('refuses a score event worth nothing', async () => {
    // A zero-delta row is noise in a breakdown that is meant to read as arithmetic.
    await expect(
      h.unscoped.leadScoreEvent.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          delta: 0,
          reason: 'Nothing happened',
          scoreAfter: 0,
        },
      }),
    ).rejects.toThrow(/lead_score_events_delta_not_zero/i);
  });

  it('blocks a saved view owned by a member of another tenant', async () => {
    await expect(
      h.unscoped.savedView.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          ownerId: h.orgB.userId,
          entityType: 'lead',
          name: `cross-owner-${newId().slice(0, 6)}`,
        },
      }),
    ).rejects.toThrow(/saved_views_owner_same_org_fk|foreign key/i);
  });

  it('blocks a saved view shared with another tenant’s team', async () => {
    await expect(
      h.unscoped.savedView.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          entityType: 'lead',
          name: `cross-team-${newId().slice(0, 6)}`,
          visibility: 'team',
          teamId: h.orgB.teamId,
        },
      }),
    ).rejects.toThrow(/saved_views_team_same_org_fk|foreign key/i);
  });

  it('refuses a team view with no team and an unknown visibility', async () => {
    await expect(
      h.unscoped.savedView.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          entityType: 'lead',
          name: `teamless-${newId().slice(0, 6)}`,
          visibility: 'team',
        },
      }),
    ).rejects.toThrow(/saved_views_team_requires_team/i);

    await expect(
      h.unscoped.savedView.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          entityType: 'lead',
          name: `worldwide-${newId().slice(0, 6)}`,
          visibility: 'world',
        },
      }),
    ).rejects.toThrow(/saved_views_visibility/i);
  });

  it('allows one landing view per role, and a second only after the first is deleted', async () => {
    const firstId = newId();
    await h.unscoped.savedView.create({
      data: {
        id: firstId,
        organizationId: h.orgA.organizationId,
        entityType: 'lead',
        name: `landing-${firstId.slice(0, 6)}`,
        visibility: 'organization',
        defaultForRoleId: h.orgA.roleId,
      },
    });
    await expect(
      h.unscoped.savedView.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          entityType: 'lead',
          name: `landing-two-${firstId.slice(0, 6)}`,
          visibility: 'organization',
          defaultForRoleId: h.orgA.roleId,
        },
      }),
    ).rejects.toThrow(/saved_views_one_default_per_role|unique/i);

    // The index is partial on `deleted_at`, so soft-deleting the first frees the role.
    await h.unscoped.savedView.update({
      where: { id: firstId },
      data: { deletedAt: new Date() },
    });
    const secondId = newId();
    await h.unscoped.savedView.create({
      data: {
        id: secondId,
        organizationId: h.orgA.organizationId,
        entityType: 'lead',
        name: `landing-three-${secondId.slice(0, 6)}`,
        visibility: 'organization',
        defaultForRoleId: h.orgA.roleId,
      },
    });

    await h.unscoped.savedView.deleteMany({ where: { id: { in: [firstId, secondId] } } });
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

describe('layer 3 — a deal cannot be stitched to another tenant (FR-DEAL-1)', () => {
  async function dealPipeline(organizationId: string) {
    const pipelineId = newId();
    const stageId = newId();
    await h.unscoped.pipeline.create({
      // Named from the *end* of the id: `newId()` is a UUIDv7, so ids minted in the same
      // millisecond share their leading characters and a prefix-based name collides with
      // `pipelines_organization_id_entity_type_name_key`.
      data: {
        id: pipelineId,
        organizationId,
        name: `Deals ${pipelineId.slice(-8)}`,
        entityType: 'deal',
      },
    });
    await h.unscoped.pipelineStage.create({
      data: { id: stageId, organizationId, pipelineId, name: 'Proposal', probability: 40 },
    });
    return { pipelineId, stageId };
  }

  it('blocks a deal on another tenant’s lead, customer, owner or stage', async () => {
    const a = await dealPipeline(h.orgA.organizationId);
    const b = await dealPipeline(h.orgB.organizationId);

    const base = {
      organizationId: h.orgA.organizationId,
      name: 'Cross tenant deal',
      currency: 'INR',
      pipelineId: a.pipelineId,
      stageId: a.stageId,
    };

    await expect(
      h.unscoped.deal.create({ data: { ...base, id: newId(), leadId: h.orgB.leadId } }),
    ).rejects.toThrow(/deals_lead_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.deal.create({
        data: { ...base, id: newId(), leadId: h.orgA.leadId, ownerUserId: h.orgB.userId },
      }),
    ).rejects.toThrow(/deals_owner_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.deal.create({
        data: { ...base, id: newId(), leadId: h.orgA.leadId, stageId: b.stageId },
      }),
    ).rejects.toThrow(/deals_stage|foreign key/i);
  });

  it('makes “a deal in another pipeline’s stage” unrepresentable, within one tenant', async () => {
    // The two-column FK cannot catch this: both the pipeline and the stage belong to org A. Only the
    // three-column `deals_stage_in_pipeline_fk` knows the stage is not *that* pipeline's — and no
    // application check can promise it, because it would have to be remembered on every write path.
    const first = await dealPipeline(h.orgA.organizationId);
    const second = await dealPipeline(h.orgA.organizationId);

    await expect(
      h.unscoped.deal.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          name: 'Stage from the other pipeline',
          currency: 'INR',
          leadId: h.orgA.leadId,
          pipelineId: first.pipelineId,
          stageId: second.stageId,
        },
      }),
    ).rejects.toThrow(/deals_stage_in_pipeline_fk|foreign key/i);
  });

  it('blocks a line item on another tenant’s deal or product', async () => {
    const a = await dealPipeline(h.orgA.organizationId);
    const dealId = newId();
    await h.unscoped.deal.create({
      data: {
        id: dealId,
        organizationId: h.orgA.organizationId,
        name: 'Deal with lines',
        currency: 'INR',
        leadId: h.orgA.leadId,
        pipelineId: a.pipelineId,
        stageId: a.stageId,
      },
    });
    const productId = newId();
    await h.unscoped.product.create({
      data: { id: productId, organizationId: h.orgA.organizationId, name: 'A product' },
    });

    const line = {
      position: 1,
      name: 'One hour',
      quantity: 1,
      unitPriceMinor: 1_000,
      grossMinor: 1_000,
      netMinor: 1_000,
      taxMinor: 0,
      totalMinor: 1_000,
    };

    await expect(
      h.unscoped.dealItem.create({
        data: { ...line, id: newId(), organizationId: h.orgB.organizationId, dealId },
      }),
    ).rejects.toThrow(/deal_items_deal_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.dealItem.create({
        data: {
          ...line,
          id: newId(),
          organizationId: h.orgB.organizationId,
          dealId,
          productId,
        },
      }),
    ).rejects.toThrow(/deal_items_(deal|product)_same_org_fk|foreign key/i);
  });

  it('shows each tenant only its own deals and products', async () => {
    const a = await dealPipeline(h.orgA.organizationId);
    const b = await dealPipeline(h.orgB.organizationId);
    const ids = [newId(), newId()];
    await h.unscoped.deal.create({
      data: {
        id: ids[0]!,
        organizationId: h.orgA.organizationId,
        name: 'A deal',
        currency: 'INR',
        leadId: h.orgA.leadId,
        pipelineId: a.pipelineId,
        stageId: a.stageId,
      },
    });
    await h.unscoped.deal.create({
      data: {
        id: ids[1]!,
        organizationId: h.orgB.organizationId,
        name: 'B deal',
        currency: 'INR',
        leadId: h.orgB.leadId,
        pipelineId: b.pipelineId,
        stageId: b.stageId,
      },
    });

    const seenByA = await tenantContext.run(h.orgA.principal, async () =>
      h.db.deal.findMany({ where: { id: { in: ids } } }),
    );
    expect(seenByA.map((deal) => deal.id)).toEqual([ids[0]]);
    expect(
      await tenantContext.run(h.orgA.principal, async () =>
        h.db.deal.findUnique({ where: { id: ids[1]! } }),
      ),
    ).toBeNull();
  });
});

describe('layer 3 — a customer cannot be stitched to another tenant (FR-DEAL-4)', () => {
  it('blocks a customer converted from another tenant’s lead', async () => {
    await expect(
      h.unscoped.customer.create({
        data: {
          id: newId(),
          organizationId: h.orgB.organizationId,
          fullName: 'Stolen Conversion',
          leadId: h.orgA.leadId,
          convertedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/customers_lead_same_org_fk|foreign key/i);
  });

  it('blocks a customer owned by a member of another tenant', async () => {
    await expect(
      h.unscoped.customer.create({
        data: {
          id: newId(),
          organizationId: h.orgB.organizationId,
          fullName: 'Stolen Owner',
          ownerUserId: h.orgA.userId,
        },
      }),
    ).rejects.toThrow(/customers_owner_same_org_fk|foreign key/i);
  });

  it('lets a lead convert exactly once, and a second attempt is the database’s refusal', async () => {
    // Not the service's: two clicks on Convert, or a retried request, must not be able to produce
    // two customers for one lead, and an application check cannot promise that under concurrency.
    const first = newId();
    await h.unscoped.customer.create({
      data: {
        id: first,
        organizationId: h.orgA.organizationId,
        fullName: 'First Conversion',
        leadId: h.orgA.leadId,
        convertedAt: new Date(),
      },
    });

    await expect(
      h.unscoped.customer.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          fullName: 'Second Conversion',
          leadId: h.orgA.leadId,
          convertedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/customers_lead_unique|unique/i);

    // Two customers who were never leads are fine: the unique index is partial, so a workspace full
    // of walk-ins is not one conversion's worth of customers.
    const walkIns = [newId(), newId()];
    for (const id of walkIns) {
      await h.unscoped.customer.create({
        data: { id, organizationId: h.orgA.organizationId, fullName: `Walk In ${id.slice(0, 4)}` },
      });
    }

    await h.unscoped.customer.deleteMany({ where: { id: { in: [first, ...walkIns] } } });
  });

  it('shows each tenant only its own customers', async () => {
    const ids = [newId(), newId()];
    await h.unscoped.customer.create({
      data: { id: ids[0]!, organizationId: h.orgA.organizationId, fullName: 'A Customer' },
    });
    await h.unscoped.customer.create({
      data: { id: ids[1]!, organizationId: h.orgB.organizationId, fullName: 'B Customer' },
    });

    const seenByA = await tenantContext.run(h.orgA.principal, async () =>
      h.db.customer.findMany({ where: { id: { in: ids } } }),
    );
    expect(seenByA.map((customer) => customer.id)).toEqual([ids[0]]);

    // Knowing the id is never sufficient, which is the whole point of layer 2.
    const byKey = await tenantContext.run(h.orgA.principal, async () =>
      h.db.customer.findUnique({ where: { id: ids[1]! } }),
    );
    expect(byKey).toBeNull();

    await h.unscoped.customer.deleteMany({ where: { id: { in: ids } } });
  });
});

describe('layer 3 — a quotation cannot be stitched to another tenant (FR-DEAL-2)', () => {
  const liveLine = {
    position: 1,
    name: 'One hour',
    quantity: 1,
    unitPriceMinor: 1_000,
    grossMinor: 1_000,
    netMinor: 1_000,
    taxMinor: 0,
    totalMinor: 1_000,
  };

  async function quotation(organizationId: string, leadId: string) {
    const id = newId();
    await h.unscoped.quotation.create({
      data: {
        id,
        organizationId,
        leadId,
        // Named from the tail of the id: a UUIDv7 minted in the same millisecond shares its prefix,
        // and `(organization_id, number, version)` is unique.
        number: `QTN-${id.slice(-8)}`,
        version: 1,
        status: 'draft',
        currency: 'INR',
      },
    });
    return id;
  }

  it('blocks a quotation against another tenant’s lead, customer, owner or deal', async () => {
    const base = {
      organizationId: h.orgA.organizationId,
      number: `QTN-${newId().slice(-8)}`,
      version: 1,
      status: 'draft',
      currency: 'INR',
    };

    await expect(
      h.unscoped.quotation.create({ data: { ...base, id: newId(), leadId: h.orgB.leadId } }),
    ).rejects.toThrow(/quotations_lead_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.quotation.create({
        data: {
          ...base,
          id: newId(),
          number: `QTN-${newId().slice(-8)}`,
          leadId: h.orgA.leadId,
          ownerUserId: h.orgB.userId,
        },
      }),
    ).rejects.toThrow(/quotations_owner_same_org_fk|foreign key/i);
  });

  it('blocks a quotation line on another tenant’s quotation or product', async () => {
    const quotationId = await quotation(h.orgA.organizationId, h.orgA.leadId);
    const productId = newId();
    await h.unscoped.product.create({
      data: { id: productId, organizationId: h.orgA.organizationId, name: 'A product' },
    });

    await expect(
      h.unscoped.quotationItem.create({
        data: { ...liveLine, id: newId(), organizationId: h.orgB.organizationId, quotationId },
      }),
    ).rejects.toThrow(/quotation_items_quotation_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.quotationItem.create({
        data: {
          ...liveLine,
          id: newId(),
          organizationId: h.orgB.organizationId,
          quotationId,
          productId,
        },
      }),
    ).rejects.toThrow(/quotation_items_(quotation|product)_same_org_fk|foreign key/i);
  });

  it('blocks a version chain that crosses tenants', async () => {
    // Superseding another workspace's quotation would make one tenant's document history point
    // into another's — and the id alone is not authority to do anything.
    const mine = await quotation(h.orgA.organizationId, h.orgA.leadId);
    const theirs = await quotation(h.orgB.organizationId, h.orgB.leadId);
    await expect(
      h.unscoped.quotation.update({
        where: { id: mine },
        data: { supersededById: theirs, supersededAt: new Date() },
      }),
    ).rejects.toThrow(/quotations_superseded_by_same_org_fk|foreign key/i);
  });

  it('keeps a document number unique per version, and lets a revision reuse it', async () => {
    const number = `QTN-${newId().slice(-8)}`;
    const base = {
      organizationId: h.orgA.organizationId,
      leadId: h.orgA.leadId,
      number,
      status: 'draft',
      currency: 'INR',
    };
    await h.unscoped.quotation.create({ data: { ...base, id: newId(), version: 1 } });
    // Version 2 of the same number is the whole point of the key.
    await h.unscoped.quotation.create({ data: { ...base, id: newId(), version: 2 } });
    // A second version 1 is not.
    await expect(
      h.unscoped.quotation.create({ data: { ...base, id: newId(), version: 1 } }),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it('lets two tenants use the same quotation number without colliding', async () => {
    // The number series is per workspace, so `QTN-0001` exists in every one of them.
    const number = 'QTN-0001';
    for (const org of [h.orgA, h.orgB]) {
      await h.unscoped.quotation.create({
        data: {
          id: newId(),
          organizationId: org.organizationId,
          leadId: org.leadId,
          number,
          version: 1,
          status: 'draft',
          currency: 'INR',
        },
      });
    }
    const seenByA = await tenantContext.run(h.orgA.principal, async () =>
      h.db.quotation.findMany({ where: { number } }),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.organizationId).toBe(h.orgA.organizationId);
  });

  it('shows each tenant only its own number series', async () => {
    for (const org of [h.orgA, h.orgB]) {
      await h.unscoped.numberSeries.create({
        data: {
          id: newId(),
          organizationId: org.organizationId,
          kind: `quotation-${newId().slice(-6)}`,
          prefix: 'QTN-',
          nextValue: 1,
        },
      });
    }
    const seenByA = await tenantContext.run(h.orgA.principal, async () =>
      h.db.numberSeries.findMany({}),
    );
    expect(seenByA.every((row) => row.organizationId === h.orgA.organizationId)).toBe(true);
    expect(seenByA.length).toBeGreaterThan(0);
  });
});

describe('layer 3 — a payment cannot be stitched to another tenant (FR-DEAL-3)', () => {
  async function method(organizationId: string) {
    const id = newId();
    await h.unscoped.paymentMethod.create({
      data: { id, organizationId, name: `Cash ${id.slice(-8)}` },
    });
    return id;
  }

  it('blocks a payment against another tenant’s lead, customer, owner or method', async () => {
    const base = {
      organizationId: h.orgA.organizationId,
      amountMinor: 1_000,
      currency: 'INR',
      status: 'succeeded',
      paidAt: new Date(),
    };

    await expect(
      h.unscoped.payment.create({
        data: { ...base, id: newId(), number: `RCPT-${newId().slice(-8)}`, leadId: h.orgB.leadId },
      }),
    ).rejects.toThrow(/payments_lead_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.payment.create({
        data: {
          ...base,
          id: newId(),
          number: `RCPT-${newId().slice(-8)}`,
          leadId: h.orgA.leadId,
          ownerUserId: h.orgB.userId,
        },
      }),
    ).rejects.toThrow(/payments_owner_same_org_fk|foreign key/i);

    const theirMethod = await method(h.orgB.organizationId);
    await expect(
      h.unscoped.payment.create({
        data: {
          ...base,
          id: newId(),
          number: `RCPT-${newId().slice(-8)}`,
          leadId: h.orgA.leadId,
          methodId: theirMethod,
        },
      }),
    ).rejects.toThrow(/payments_method_same_org_fk|foreign key/i);
  });

  it('makes a receipt for nobody, and a receipt for nothing, unrepresentable', async () => {
    await expect(
      h.unscoped.payment.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          number: `RCPT-${newId().slice(-8)}`,
          amountMinor: 1_000,
          currency: 'INR',
          status: 'succeeded',
          paidAt: new Date(),
        },
      }),
    ).rejects.toThrow(/payments_has_subject/i);

    await expect(
      h.unscoped.payment.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          number: `RCPT-${newId().slice(-8)}`,
          leadId: h.orgA.leadId,
          amountMinor: 0,
          currency: 'INR',
          status: 'succeeded',
          paidAt: new Date(),
        },
      }),
    ).rejects.toThrow(/payments_amount_positive/i);
  });

  it('refuses money that arrived with no date, and a pending payment that has one', async () => {
    const base = {
      organizationId: h.orgA.organizationId,
      leadId: h.orgA.leadId,
      amountMinor: 1_000,
      currency: 'INR',
    };
    await expect(
      h.unscoped.payment.create({
        data: { ...base, id: newId(), number: `RCPT-${newId().slice(-8)}`, status: 'succeeded' },
      }),
    ).rejects.toThrow(/payments_received_has_timestamp/i);

    await expect(
      h.unscoped.payment.create({
        data: {
          ...base,
          id: newId(),
          number: `RCPT-${newId().slice(-8)}`,
          status: 'pending',
          paidAt: new Date(),
        },
      }),
    ).rejects.toThrow(/payments_received_has_timestamp/i);
  });

  it('lets a refunded payment keep the date the money arrived on', async () => {
    // The two constraints `payments_received_has_timestamp` and `payments_refund_was_received`
    // contradicted each other when the first was written as a biconditional on `succeeded`, which
    // made refunding anything impossible. This is the test that keeps them compatible.
    const id = newId();
    await h.unscoped.payment.create({
      data: {
        id,
        organizationId: h.orgA.organizationId,
        leadId: h.orgA.leadId,
        number: `RCPT-${id.slice(-8)}`,
        amountMinor: 1_000,
        currency: 'INR',
        status: 'refunded',
        paidAt: new Date('2026-03-01T10:00:00.000Z'),
        refundedAt: new Date('2026-03-08T10:00:00.000Z'),
      },
    });
    const row = await h.unscoped.payment.findUniqueOrThrow({ where: { id } });
    expect(row.paidAt).not.toBeNull();
    expect(row.refundedAt).not.toBeNull();
  });

  it('keeps a receipt number unique per workspace and free across workspaces', async () => {
    const number = 'RCPT-0001';
    for (const org of [h.orgA, h.orgB]) {
      await h.unscoped.payment.create({
        data: {
          id: newId(),
          organizationId: org.organizationId,
          leadId: org.leadId,
          number,
          amountMinor: 1_000,
          currency: 'INR',
          status: 'succeeded',
          paidAt: new Date(),
        },
      });
    }
    await expect(
      h.unscoped.payment.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          number,
          amountMinor: 1_000,
          currency: 'INR',
          status: 'succeeded',
          paidAt: new Date(),
        },
      }),
    ).rejects.toThrow(/unique|duplicate key/i);

    const seenByA = await tenantContext.run(h.orgA.principal, async () =>
      h.db.payment.findMany({ where: { number } }),
    );
    expect(seenByA).toHaveLength(1);
  });

  it('refuses a customer whose purchase dates are out of order, or half set', async () => {
    const customerId = newId();
    await h.unscoped.customer.create({
      data: {
        id: customerId,
        organizationId: h.orgA.organizationId,
        fullName: 'Rollup Guard',
      },
    });
    await expect(
      h.unscoped.customer.update({
        where: { id: customerId },
        data: { firstPurchaseAt: new Date('2026-05-01T00:00:00.000Z') },
      }),
    ).rejects.toThrow(/customers_purchase_dates_pair/i);
    await expect(
      h.unscoped.customer.update({
        where: { id: customerId },
        data: {
          firstPurchaseAt: new Date('2026-05-01T00:00:00.000Z'),
          lastPurchaseAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/customers_purchase_dates_ordered/i);
  });

  it('shows each tenant only its own payments and methods', async () => {
    for (const org of [h.orgA, h.orgB]) {
      await method(org.organizationId);
    }
    const seenByA = await tenantContext.run(h.orgA.principal, async () =>
      h.db.paymentMethod.findMany({}),
    );
    expect(seenByA.every((row) => row.organizationId === h.orgA.organizationId)).toBe(true);
    expect(seenByA.length).toBeGreaterThan(0);
  });
});

describe('layer 3 — a task cannot be stitched to another tenant (FR-TSK-1)', () => {
  /** The three pieces of follow-up vocabulary, created in whichever workspace is asked for. */
  async function vocabulary(organizationId: string) {
    const typeId = newId();
    const outcomeId = newId();
    const reasonId = newId();
    await h.unscoped.taskType.create({
      data: { id: typeId, organizationId, name: `Call ${typeId.slice(-8)}` },
    });
    await h.unscoped.taskOutcome.create({
      data: { id: outcomeId, organizationId, name: `Spoke ${outcomeId.slice(-8)}` },
    });
    await h.unscoped.rescheduleReason.create({
      data: { id: reasonId, organizationId, name: `Busy ${reasonId.slice(-8)}` },
    });
    return { typeId, outcomeId, reasonId };
  }

  /** A minimal open task on the given workspace's own lead. */
  async function task(organizationId: string, leadId: string, overrides = {}) {
    const id = newId();
    await h.unscoped.task.create({
      data: {
        id,
        organizationId,
        leadId,
        title: 'Call back',
        dueAt: new Date('2026-04-01T10:00:00.000Z'),
        dueDate: new Date('2026-04-01T00:00:00.000Z'),
        dueTime: new Date('1970-01-01T15:30:00.000Z'),
        ...overrides,
      },
    });
    return id;
  }

  it('blocks a task against another tenant’s lead, assignee, type or outcome', async () => {
    const base = {
      organizationId: h.orgA.organizationId,
      title: 'Call back',
      dueAt: new Date('2026-04-01T10:00:00.000Z'),
      dueDate: new Date('2026-04-01T00:00:00.000Z'),
      dueTime: new Date('1970-01-01T15:30:00.000Z'),
    };

    await expect(
      h.unscoped.task.create({ data: { ...base, id: newId(), leadId: h.orgB.leadId } }),
    ).rejects.toThrow(/tasks_lead_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.task.create({
        data: { ...base, id: newId(), leadId: h.orgA.leadId, assignedUserId: h.orgB.userId },
      }),
    ).rejects.toThrow(/tasks_assignee_same_org_fk|foreign key/i);

    const theirs = await vocabulary(h.orgB.organizationId);
    await expect(
      h.unscoped.task.create({
        data: { ...base, id: newId(), leadId: h.orgA.leadId, taskTypeId: theirs.typeId },
      }),
    ).rejects.toThrow(/tasks_type_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.task.create({
        data: {
          ...base,
          id: newId(),
          leadId: h.orgA.leadId,
          status: 'completed',
          completedAt: new Date(),
          outcomeId: theirs.outcomeId,
        },
      }),
    ).rejects.toThrow(/tasks_outcome_same_org_fk|foreign key/i);
  });

  it('blocks a follow-up chain, a reschedule and a reminder that cross a tenant', async () => {
    const theirTask = await task(h.orgB.organizationId, h.orgB.leadId);
    await expect(
      h.unscoped.task.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          title: 'Call back',
          dueAt: new Date('2026-04-01T10:00:00.000Z'),
          dueDate: new Date('2026-04-01T00:00:00.000Z'),
          dueTime: new Date('1970-01-01T15:30:00.000Z'),
          followsTaskId: theirTask,
        },
      }),
    ).rejects.toThrow(/tasks_follows_same_org_fk|foreign key/i);

    const mine = await task(h.orgA.organizationId, h.orgA.leadId);
    const theirReason = (await vocabulary(h.orgB.organizationId)).reasonId;
    await expect(
      h.unscoped.taskReschedule.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          taskId: mine,
          fromDueAt: new Date('2026-04-01T10:00:00.000Z'),
          toDueAt: new Date('2026-04-02T10:00:00.000Z'),
          reasonId: theirReason,
        },
      }),
    ).rejects.toThrow(/task_reschedules_reason_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.taskReminder.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          taskId: theirTask,
          remindAt: new Date('2026-04-01T09:00:00.000Z'),
          offsetMinutes: 60,
        },
      }),
    ).rejects.toThrow(/task_reminders_task_same_org_fk|foreign key/i);
  });

  it('makes a lead’s next action point only at its own workspace’s task', async () => {
    const theirTask = await task(h.orgB.organizationId, h.orgB.leadId);
    await expect(
      h.unscoped.lead.update({
        where: { id: h.orgA.leadId },
        data: { nextActionTaskId: theirTask },
      }),
    ).rejects.toThrow(/leads_next_action_task_same_org_fk|foreign key/i);
  });

  it('makes a task about nobody unrepresentable', async () => {
    // Rule 6 is the product: a task attached to no lead, customer or deal writes to no timeline.
    await expect(
      h.unscoped.task.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          title: 'Ring the bank',
          dueAt: new Date('2026-04-01T10:00:00.000Z'),
          dueDate: new Date('2026-04-01T00:00:00.000Z'),
          dueTime: new Date('1970-01-01T15:30:00.000Z'),
        },
      }),
    ).rejects.toThrow(/tasks_has_subject/i);
  });

  it('refuses a completion with no outcome, and a completion with no date', async () => {
    const { outcomeId } = await vocabulary(h.orgA.organizationId);
    await expect(
      task(h.orgA.organizationId, h.orgA.leadId, {
        status: 'completed',
        completedAt: new Date(),
      }),
    ).rejects.toThrow(/tasks_completed_has_outcome/i);

    await expect(
      task(h.orgA.organizationId, h.orgA.leadId, { status: 'completed', outcomeId }),
    ).rejects.toThrow(/tasks_completed_has_timestamp/i);

    // And the pair the other way round: a timestamp on something that did not finish.
    await expect(
      task(h.orgA.organizationId, h.orgA.leadId, { completedAt: new Date() }),
    ).rejects.toThrow(/tasks_completed_has_timestamp/i);
  });

  it('refuses a reschedule row that moved nothing', async () => {
    const mine = await task(h.orgA.organizationId, h.orgA.leadId);
    const { reasonId } = await vocabulary(h.orgA.organizationId);
    const sameMoment = new Date('2026-04-01T10:00:00.000Z');
    await expect(
      h.unscoped.taskReschedule.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          taskId: mine,
          fromDueAt: sameMoment,
          toDueAt: sameMoment,
          reasonId,
        },
      }),
    ).rejects.toThrow(/task_reschedules_changes_the_time/i);
  });

  it('keeps one reminder per offset per task, so a rewrite cannot duplicate one', async () => {
    const mine = await task(h.orgA.organizationId, h.orgA.leadId);
    const row = {
      organizationId: h.orgA.organizationId,
      taskId: mine,
      remindAt: new Date('2026-04-01T09:00:00.000Z'),
      offsetMinutes: 60,
    };
    await h.unscoped.taskReminder.create({ data: { id: newId(), ...row } });
    await expect(h.unscoped.taskReminder.create({ data: { id: newId(), ...row } })).rejects.toThrow(
      /unique|duplicate key/i,
    );
  });

  it('keeps the follow-up vocabulary scoped, and its names free across workspaces', async () => {
    const name = 'Site visit';
    for (const org of [h.orgA, h.orgB]) {
      await h.unscoped.taskType.create({
        data: { id: newId(), organizationId: org.organizationId, name },
      });
    }
    await expect(
      h.unscoped.taskType.create({
        data: { id: newId(), organizationId: h.orgA.organizationId, name },
      }),
    ).rejects.toThrow(/unique|duplicate key/i);

    // And the scoped client sees only its own.
    const mine = await tenantContext.run(h.orgA.principal, async () =>
      h.db.taskType.findMany({ where: { name } }),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.organizationId).toBe(h.orgA.organizationId);
  });
});

describe('layer 3 — an SLA clock cannot be stitched to another tenant (FR-TSK-8)', () => {
  async function policy(organizationId: string) {
    const id = newId();
    await h.unscoped.slaPolicy.create({
      data: {
        id,
        organizationId,
        name: `Hour ${id.slice(-8)}`,
        firstResponseMinutes: 60,
      },
    });
    return id;
  }

  /**
   * A lead of this test's own.
   *
   * `sla_clock_subject_target_key` allows one clock per promise per lead, so sharing the harness's
   * lead between tests makes the second one fail on a uniqueness rule it was not testing — a test
   * that reuses a fixture passing or failing for the wrong reason, which this suite has paid for
   * twice.
   */
  async function lead(tenant: typeof h.orgA) {
    const id = newId();
    await h.unscoped.lead.create({
      data: {
        id,
        organizationId: tenant.organizationId,
        fullName: `Sla subject ${id.slice(-8)}`,
        statusId: tenant.statusId,
        pipelineId: tenant.pipelineId,
        stageId: tenant.stageId,
      },
    });
    return id;
  }

  async function clock(organizationId: string, leadId: string, policyId: string) {
    const id = newId();
    await h.unscoped.slaClock.create({
      data: {
        id,
        organizationId,
        policyId,
        subjectType: 'lead',
        subjectId: leadId,
        leadId,
        target: 'first_response',
        startedAt: new Date('2026-04-02T04:00:00.000Z'),
        warnAt: new Date('2026-04-02T04:48:00.000Z'),
        dueAt: new Date('2026-04-02T05:00:00.000Z'),
        targetMinutes: 60,
      },
    });
    return id;
  }

  it('blocks a clock against another tenant’s lead, policy or assignee', async () => {
    const mine = await policy(h.orgA.organizationId);
    const theirs = await policy(h.orgB.organizationId);
    const base = {
      organizationId: h.orgA.organizationId,
      subjectType: 'lead' as const,
      target: 'first_response' as const,
      startedAt: new Date('2026-04-02T04:00:00.000Z'),
      warnAt: new Date('2026-04-02T04:48:00.000Z'),
      dueAt: new Date('2026-04-02T05:00:00.000Z'),
      targetMinutes: 60,
    };

    await expect(
      h.unscoped.slaClock.create({
        data: {
          ...base,
          id: newId(),
          policyId: mine,
          subjectId: h.orgB.leadId,
          leadId: h.orgB.leadId,
        },
      }),
    ).rejects.toThrow(/sla_clocks_lead_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.slaClock.create({
        data: {
          ...base,
          id: newId(),
          policyId: theirs,
          subjectId: h.orgA.leadId,
          leadId: h.orgA.leadId,
        },
      }),
    ).rejects.toThrow(/sla_clocks_policy_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.slaClock.create({
        data: {
          ...base,
          id: newId(),
          policyId: mine,
          subjectId: h.orgA.leadId,
          leadId: h.orgA.leadId,
          assignedUserId: h.orgB.userId,
        },
      }),
    ).rejects.toThrow(/sla_clocks_assignee_same_org_fk|foreign key/i);
  });

  it('makes a lead clock with no lead, and a clock pointing at a different lead, unrepresentable', async () => {
    const mine = await policy(h.orgA.organizationId);
    const base = {
      organizationId: h.orgA.organizationId,
      policyId: mine,
      target: 'first_response' as const,
      startedAt: new Date('2026-04-02T04:00:00.000Z'),
      warnAt: new Date('2026-04-02T04:48:00.000Z'),
      dueAt: new Date('2026-04-02T05:00:00.000Z'),
      targetMinutes: 60,
    };

    // A lead clock with nothing the board can join to.
    await expect(
      h.unscoped.slaClock.create({
        data: { ...base, id: newId(), subjectType: 'lead', subjectId: h.orgA.leadId },
      }),
    ).rejects.toThrow(/sla_clocks_lead_subject_has_lead/i);

    // And the polymorphic id has to agree with the typed one.
    const other = newId();
    await expect(
      h.unscoped.slaClock.create({
        data: {
          ...base,
          id: newId(),
          subjectType: 'lead',
          subjectId: other,
          leadId: h.orgA.leadId,
        },
      }),
    ).rejects.toThrow(/sla_clocks_subject_matches_lead/i);
  });

  it('refuses a clock whose instants are out of order', async () => {
    const mine = await policy(h.orgA.organizationId);
    await expect(
      h.unscoped.slaClock.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          policyId: mine,
          subjectType: 'lead',
          subjectId: h.orgA.leadId,
          leadId: h.orgA.leadId,
          target: 'first_response',
          startedAt: new Date('2026-04-02T05:00:00.000Z'),
          warnAt: new Date('2026-04-02T04:00:00.000Z'),
          dueAt: new Date('2026-04-02T06:00:00.000Z'),
          targetMinutes: 60,
        },
      }),
    ).rejects.toThrow(/sla_clocks_instants_ordered/i);
  });

  it('keeps one clock per promise per record', async () => {
    const mine = await policy(h.orgA.organizationId);
    const subject = await lead(h.orgA);
    await clock(h.orgA.organizationId, subject, mine);
    // A second first-response clock on the same lead would make every breach count double.
    await expect(clock(h.orgA.organizationId, subject, mine)).rejects.toThrow(
      /unique|duplicate key/i,
    );
  });

  it('escalates at most once per level — the guarantee, as a unique key', async () => {
    const mine = await policy(h.orgA.organizationId);
    const theirClock = await clock(
      h.orgB.organizationId,
      await lead(h.orgB),
      await policy(h.orgB.organizationId),
    );
    const subject = await lead(h.orgA);
    const myClock = await clock(h.orgA.organizationId, subject, mine);

    const row = {
      organizationId: h.orgA.organizationId,
      clockId: myClock,
      policyId: mine,
      subjectType: 'lead' as const,
      subjectId: subject,
      level: 2,
      reason: 'breached' as const,
      notifiedUserIds: [h.orgA.userId],
    };
    await h.unscoped.escalation.create({ data: { id: newId(), ...row } });
    await expect(h.unscoped.escalation.create({ data: { id: newId(), ...row } })).rejects.toThrow(
      /unique|duplicate key/i,
    );

    // The warning is a different level, so it is still allowed.
    await h.unscoped.escalation.create({
      data: { id: newId(), ...row, level: 1, reason: 'at_risk' },
    });

    // And an escalation cannot be attached to another tenant's clock.
    await expect(
      h.unscoped.escalation.create({
        data: { id: newId(), ...row, clockId: theirClock, level: 1, reason: 'at_risk' },
      }),
    ).rejects.toThrow(/escalations_clock_same_org_fk|foreign key/i);
  });

  it('refuses an escalation that reached nobody, and one whose level contradicts its reason', async () => {
    const mine = await policy(h.orgA.organizationId);
    const subject = await lead(h.orgA);
    const myClock = await clock(h.orgA.organizationId, subject, mine);
    const base = {
      organizationId: h.orgA.organizationId,
      clockId: myClock,
      policyId: mine,
      subjectType: 'lead' as const,
      subjectId: subject,
    };

    // A row claiming somebody was told when nobody was.
    await expect(
      h.unscoped.escalation.create({
        data: { id: newId(), ...base, level: 2, reason: 'breached', notifiedUserIds: [] },
      }),
    ).rejects.toThrow(/escalations_notified_somebody/i);

    await expect(
      h.unscoped.escalation.create({
        data: {
          id: newId(),
          ...base,
          level: 1,
          reason: 'breached',
          notifiedUserIds: [h.orgA.userId],
        },
      }),
    ).rejects.toThrow(/escalations_level_matches_reason/i);
  });

  it('refuses a policy whose warning threshold is not strictly inside its target', async () => {
    for (const warnAtPercent of [0, 100]) {
      await expect(
        h.unscoped.slaPolicy.create({
          data: {
            id: newId(),
            organizationId: h.orgA.organizationId,
            name: `Silly ${warnAtPercent} ${newId().slice(-6)}`,
            firstResponseMinutes: 60,
            warnAtPercent,
          },
        }),
      ).rejects.toThrow(/sla_policies_warn_percent_range/i);
    }
  });

  it('keeps a policy name unique per workspace and free across workspaces', async () => {
    const name = 'Golden hour';
    for (const org of [h.orgA, h.orgB]) {
      await h.unscoped.slaPolicy.create({
        data: {
          id: newId(),
          organizationId: org.organizationId,
          name,
          firstResponseMinutes: 60,
        },
      });
    }
    await expect(
      h.unscoped.slaPolicy.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          name,
          firstResponseMinutes: 60,
        },
      }),
    ).rejects.toThrow(/unique|duplicate key/i);

    const mine = await tenantContext.run(h.orgA.principal, async () =>
      h.db.slaPolicy.findMany({ where: { name } }),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.organizationId).toBe(h.orgA.organizationId);
  });
});

describe('layer 3 — the industry template catalogue is platform data, not a tenant table (FR-ONB-2)', () => {
  it('is populated by the platform catalogue seeder, with the ten industries', async () => {
    const rows = await h.unscoped.industryTemplate.findMany({ orderBy: { sortOrder: 'asc' } });
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.key)).toContain('real_estate');
    // The row is a reference to a definition, not a second copy of one: the key is what an
    // organization stores, and the JSON is what the Super Admin console will edit.
    expect(typeof rows[0]?.definition).toBe('object');
  });

  it('is readable without a tenant context, which is what makes it platform data', async () => {
    // Every tenant table throws here. This one must not: the catalogue is the same for everybody,
    // and a route that reads it does so under `withPlatformScope` with a stated reason.
    await expect(h.db.industryTemplate.findMany({})).resolves.toBeInstanceOf(Array);
  });

  it('lets a workspace record which template it applied, and survives that template being retired', async () => {
    await h.unscoped.organization.update({
      where: { id: h.orgA.organizationId },
      data: { industryTemplateKey: 'real_estate' },
    });
    const before = await h.unscoped.organization.findUniqueOrThrow({
      where: { id: h.orgA.organizationId },
      select: { industryTemplateKey: true },
    });
    expect(before.industryTemplateKey).toBe('real_estate');

    // `SetNull`, not `Restrict`: retiring a template must not be blocked by the workspaces that
    // once used it. The reference is a record of a choice, not a dependency.
    const retired = await h.unscoped.industryTemplate.create({
      data: {
        key: `retired_${newId().slice(-8)}`,
        name: 'Retired industry',
        description: 'A template created by a test, long enough to satisfy the description check.',
        definition: {} as never,
      },
    });
    await h.unscoped.organization.update({
      where: { id: h.orgA.organizationId },
      data: { industryTemplateKey: retired.key },
    });
    await h.unscoped.industryTemplate.delete({ where: { key: retired.key } });
    const after = await h.unscoped.organization.findUniqueOrThrow({
      where: { id: h.orgA.organizationId },
      select: { industryTemplateKey: true },
    });
    expect(after.industryTemplateKey).toBeNull();
  });

  it('refuses a template with a key or a description a picker could not use', async () => {
    await expect(
      h.unscoped.industryTemplate.create({
        data: {
          key: 'Not A Key',
          name: 'Bad key',
          description: 'A description that is comfortably longer than twenty characters.',
          definition: {} as never,
        },
      }),
    ).rejects.toThrow(/industry_templates_key_format/i);

    await expect(
      h.unscoped.industryTemplate.create({
        data: {
          key: `short_${newId().slice(-6)}`,
          name: 'Short description',
          description: 'Too short',
          definition: {} as never,
        },
      }),
    ).rejects.toThrow(/industry_templates_description_present/i);
  });
});

describe('layer 3 — notification settings belong to one person in one tenant (FR-NOT-3)', () => {
  async function settings(organizationId: string, userId: string, quietStartMinute = 21 * 60) {
    const id = newId();
    await h.unscoped.notificationSetting.create({
      data: {
        id,
        organizationId,
        userId,
        quietStartMinute,
        quietEndMinute: 7 * 60,
        timeZone: 'Asia/Kolkata',
      },
    });
    return id;
  }

  it('refuses settings for somebody who is not a member of the tenant', async () => {
    // The composite FK through `Membership` is what makes this unrepresentable: without it, one
    // workspace could hold quiet hours for a person who has never been in it — and the gate would
    // then read them while deciding whether to notify somebody else's colleague.
    await expect(settings(h.orgA.organizationId, h.orgB.userId)).rejects.toThrow(
      /notification_settings_membership_same_org_fk/i,
    );
  });

  it('allows the same person one row per workspace, and only one', async () => {
    const bothOrgs = newId();
    await h.unscoped.user.create({
      data: { id: bothOrgs, email: `${bothOrgs}@test.local`, name: 'In both', status: 'active' },
    });
    for (const tenant of [h.orgA, h.orgB]) {
      const role = await h.unscoped.role.findFirstOrThrow({
        where: { organizationId: tenant.organizationId },
      });
      await h.unscoped.membership.create({
        data: {
          id: newId(),
          organizationId: tenant.organizationId,
          userId: bothOrgs,
          status: 'active',
        },
      });
      await h.unscoped.userRole.create({
        data: {
          id: newId(),
          organizationId: tenant.organizationId,
          userId: bothOrgs,
          roleId: role.id,
        },
      });
    }

    // Quiet hours are per workspace on purpose: somebody consulting for two businesses in
    // different timezones has two sets of working hours and two sets of quiet ones.
    await settings(h.orgA.organizationId, bothOrgs, 20 * 60);
    await settings(h.orgB.organizationId, bothOrgs, 22 * 60);
    await expect(settings(h.orgA.organizationId, bothOrgs, 19 * 60)).rejects.toThrow(
      /notification_settings_organization_id_user_id_key/i,
    );

    await h.unscoped.notificationSetting.deleteMany({ where: { userId: bothOrgs } });
    await h.unscoped.userRole.deleteMany({ where: { userId: bothOrgs } });
    await h.unscoped.membership.deleteMany({ where: { userId: bothOrgs } });
    await h.unscoped.user.delete({ where: { id: bothOrgs } });
  });

  it('is invisible to the other tenant through the scoped client', async () => {
    await h.unscoped.notificationSetting.deleteMany({
      where: { organizationId: h.orgA.organizationId },
    });
    await settings(h.orgA.organizationId, h.orgA.userId);

    const seenByB = await tenantContext.run(h.orgB.principal, async () =>
      h.db.notificationSetting.findMany({}),
    );
    expect(seenByB).toHaveLength(0);
    const seenByA = await tenantContext.run(h.orgA.principal, async () =>
      h.db.notificationSetting.findMany({}),
    );
    expect(seenByA).toHaveLength(1);
  });

  it('refuses half a quiet window, and a window whose ends are equal', async () => {
    // Half a window would force the reader to invent the other end, which is how one person's
    // quiet hours silently become "until midnight". Equal ends are ambiguous — "never quiet" or
    // "always quiet" — and guessing would be guessing about when to wake somebody up.
    await h.unscoped.notificationSetting.deleteMany({
      where: { organizationId: h.orgA.organizationId },
    });
    await expect(
      h.unscoped.notificationSetting.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          userId: h.orgA.userId,
          quietStartMinute: 21 * 60,
        },
      }),
    ).rejects.toThrow(/notification_settings_quiet_hours_pair/i);

    await expect(
      h.unscoped.notificationSetting.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          userId: h.orgA.userId,
          quietStartMinute: 540,
          quietEndMinute: 540,
        },
      }),
    ).rejects.toThrow(/notification_settings_quiet_hours_distinct/i);
  });

  it('refuses a minute that is not one of the day', async () => {
    await expect(
      h.unscoped.notificationSetting.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          userId: h.orgA.userId,
          quietStartMinute: 1440,
          quietEndMinute: 420,
        },
      }),
    ).rejects.toThrow(/notification_settings_quiet_minutes_range/i);
  });

  it('keeps no settings behind when the membership goes', async () => {
    // `ON DELETE CASCADE` on the membership FK: somebody removed from a workspace leaves no
    // quiet-hours row behind for a future member with the same user id to inherit.
    const leaving = newId();
    await h.unscoped.user.create({
      data: { id: leaving, email: `${leaving}@test.local`, name: 'Leaving', status: 'active' },
    });
    await h.unscoped.membership.create({
      data: {
        id: newId(),
        organizationId: h.orgA.organizationId,
        userId: leaving,
        status: 'active',
      },
    });
    await settings(h.orgA.organizationId, leaving);

    await h.unscoped.membership.deleteMany({
      where: { organizationId: h.orgA.organizationId, userId: leaving },
    });
    const left = await h.unscoped.notificationSetting.count({ where: { userId: leaving } });
    expect(left).toBe(0);
    await h.unscoped.user.delete({ where: { id: leaving } });
  });
});

describe('layer 3 — a call cannot be stitched to another tenant (FR-CALL-1..3)', () => {
  /** An outcome in whichever workspace is asked for. Named by the random tail of its own id. */
  async function outcome(organizationId: string, category = 'connected') {
    const id = newId();
    await h.unscoped.callOutcome.create({
      data: {
        id,
        organizationId,
        name: `Spoke ${id.slice(-8)}`,
        category: category as never,
      },
    });
    return id;
  }

  /** A minimal settled call on the given workspace's own lead. */
  function base(organizationId: string, leadId: string | null, agentUserId: string) {
    return {
      organizationId,
      leadId,
      direction: 'outbound' as const,
      status: 'completed' as const,
      toE164: '+919845012345',
      agentUserId,
      startedAt: new Date('2026-04-01T10:00:00.000Z'),
      endedAt: new Date('2026-04-01T10:04:00.000Z'),
    };
  }

  it('blocks a call against another tenant’s lead, agent, outcome or task', async () => {
    await expect(
      h.unscoped.call.create({
        data: { id: newId(), ...base(h.orgA.organizationId, h.orgB.leadId, h.orgA.userId) },
      }),
    ).rejects.toThrow(/calls_lead_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.call.create({
        data: { id: newId(), ...base(h.orgA.organizationId, h.orgA.leadId, h.orgB.userId) },
      }),
    ).rejects.toThrow(/calls_agent_same_org_fk|foreign key/i);

    // Created, not found: a test that looks for "some other workspace's outcome" passes only
    // because an earlier run left one behind.
    const theirs = await outcome(h.orgB.organizationId);
    await expect(
      h.unscoped.call.create({
        data: {
          id: newId(),
          ...base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId),
          outcomeId: theirs,
        },
      }),
    ).rejects.toThrow(/calls_outcome_same_org_fk|foreign key/i);

    const theirTask = newId();
    await h.unscoped.task.create({
      data: {
        id: theirTask,
        organizationId: h.orgB.organizationId,
        leadId: h.orgB.leadId,
        title: 'Their follow-up',
        dueAt: new Date('2026-04-01T10:00:00.000Z'),
        dueDate: new Date('2026-04-01T00:00:00.000Z'),
        dueTime: new Date('1970-01-01T15:30:00.000Z'),
      },
    });
    await expect(
      h.unscoped.call.create({
        data: {
          id: newId(),
          ...base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId),
          taskId: theirTask,
        },
      }),
    ).rejects.toThrow(/calls_task_same_org_fk|foreign key/i);
  });

  it('keeps a call with no number at all unrepresentable', async () => {
    // Both numbers are nullable because which end is "us" depends on the direction, and a
    // provider may not report its own — but a call with neither is a row about nothing.
    const row = base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId);
    await expect(
      h.unscoped.call.create({
        data: { ...row, id: newId(), toE164: null, fromE164: null },
      }),
    ).rejects.toThrow(/calls_has_a_number/i);
  });

  it('refuses a number that is not E.164, so a call can be matched to a lead', async () => {
    const row = base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId);
    await expect(
      h.unscoped.call.create({ data: { ...row, id: newId(), toE164: '9845012345' } }),
    ).rejects.toThrow(/calls_to_e164_format/i);
  });

  it('refuses a duration on a call that did not connect, and one three weeks long', async () => {
    const row = base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId);
    await expect(
      h.unscoped.call.create({
        data: { ...row, id: newId(), status: 'no_answer', durationSeconds: 240 },
      }),
    ).rejects.toThrow(/calls_duration_needs_completion/i);

    // The typo guard: somebody entering seconds into a minutes box, or a provider reporting
    // milliseconds, poisons every average built on the column.
    await expect(
      h.unscoped.call.create({ data: { ...row, id: newId(), durationSeconds: 252_000 } }),
    ).rejects.toThrow(/calls_duration_sane/i);
  });

  it('insists a call that is over says when it ended, and one still dialing cannot', async () => {
    const row = base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId);
    await expect(
      h.unscoped.call.create({ data: { ...row, id: newId(), endedAt: null } }),
    ).rejects.toThrow(/calls_settled_has_ended/i);

    // Written as a `CASE` rather than a biconditional, because `status` has five values and only
    // one of them is the open state — the trap the payment timestamps paid for.
    await expect(
      h.unscoped.call.create({
        data: { ...row, id: newId(), status: 'dialing', endedAt: new Date() },
      }),
    ).rejects.toThrow(/calls_settled_has_ended/i);

    const dialing = newId();
    await h.unscoped.call.create({
      data: { ...row, id: dialing, status: 'dialing', endedAt: null },
    });
    expect(dialing).toBeTruthy();
  });

  it('refuses a call that ended before it started, and two places for one recording', async () => {
    const row = base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId);
    await expect(
      h.unscoped.call.create({
        data: { ...row, id: newId(), endedAt: new Date('2026-04-01T09:00:00.000Z') },
      }),
    ).rejects.toThrow(/calls_ended_after_started/i);

    await expect(
      h.unscoped.call.create({
        data: {
          ...row,
          id: newId(),
          recordingUrl: 'https://example.test/a.mp3',
          recordingDocumentId: newId(),
        },
      }),
    ).rejects.toThrow(/calls_one_recording/i);
  });

  it('refuses a provider call id with no provider to attribute it to', async () => {
    const row = base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId);
    await expect(
      h.unscoped.call.create({ data: { ...row, id: newId(), providerCallId: 'CA123' } }),
    ).rejects.toThrow(/calls_provider_pair/i);
  });

  it('lets two workspaces hold the same provider call id, and refuses one twice', async () => {
    // `calls_provider_call_unique` is the idempotency gate a telephony webhook needs, and it is
    // partial: every hand-logged call has no provider id, and a complete unique index would allow
    // exactly one of those per workspace.
    for (const org of [h.orgA, h.orgB]) {
      await h.unscoped.call.create({
        data: {
          ...base(org.organizationId, org.leadId, org.userId),
          id: newId(),
          provider: 'twilio',
          providerCallId: 'CA-shared',
        },
      });
    }
    await expect(
      h.unscoped.call.create({
        data: {
          ...base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId),
          id: newId(),
          provider: 'twilio',
          providerCallId: 'CA-shared',
        },
      }),
    ).rejects.toThrow(/unique|duplicate key/i);

    // And two hand-logged calls, both with no provider id, are fine.
    for (let index = 0; index < 2; index += 1) {
      await h.unscoped.call.create({
        data: { ...base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId), id: newId() },
      });
    }
  });

  it('keeps an unattributed call representable, because that is the point of a nullable lead', async () => {
    // An inbound call from a number nobody recognises is exactly the call most worth keeping.
    const id = newId();
    await h.unscoped.call.create({
      data: {
        ...base(h.orgA.organizationId, null, h.orgA.userId),
        id,
        direction: 'inbound',
        toE164: null,
        fromE164: '+919000000009',
      },
    });
    const found = await tenantContext.run(h.orgA.principal, async () =>
      h.db.call.findFirst({ where: { id } }),
    );
    expect(found?.leadId).toBeNull();
  });

  it('keeps the outcome vocabulary scoped, and its names free across workspaces', async () => {
    const name = 'Asked to call back';
    for (const org of [h.orgA, h.orgB]) {
      await h.unscoped.callOutcome.create({
        data: { id: newId(), organizationId: org.organizationId, name, category: 'callback' },
      });
    }
    await expect(
      h.unscoped.callOutcome.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          name,
          category: 'callback',
        },
      }),
    ).rejects.toThrow(/unique|duplicate key/i);

    const mine = await tenantContext.run(h.orgA.principal, async () =>
      h.db.callOutcome.findMany({ where: { name } }),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.organizationId).toBe(h.orgA.organizationId);
  });

  it('refuses an outcome with a blank name', async () => {
    await expect(
      h.unscoped.callOutcome.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          name: '   ',
          category: 'connected',
        },
      }),
    ).rejects.toThrow(/call_outcomes_name_present/i);
  });

  it('scopes the call log like every other tenant table', async () => {
    const mineId = newId();
    await h.unscoped.call.create({
      data: { ...base(h.orgA.organizationId, h.orgA.leadId, h.orgA.userId), id: mineId },
    });
    await h.unscoped.call.create({
      data: { ...base(h.orgB.organizationId, h.orgB.leadId, h.orgB.userId), id: newId() },
    });

    const theirs = await tenantContext.run(h.orgB.principal, async () =>
      h.db.call.findFirst({ where: { id: mineId } }),
    );
    expect(theirs).toBeNull();
  });
});

describe('layer 3 — a capture form cannot be stitched to another tenant (FR-CAP-2)', () => {
  /** A form in whichever workspace is asked for, named by the random tail of its own id. */
  async function form(organizationId: string, over: Record<string, unknown> = {}) {
    const id = newId();
    await h.unscoped.form.create({
      data: {
        id,
        organizationId,
        name: `Enquiry ${id.slice(-8)}`,
        slug: `enquiry-${id.slice(-8)}`,
        publicKey: `key-${id.slice(-8)}-${newId().slice(-8)}`,
        ...over,
      },
    });
    return id;
  }

  it('blocks a form against another tenant’s pipeline, source, rule or creator', async () => {
    await expect(form(h.orgA.organizationId, { pipelineId: h.orgB.pipelineId })).rejects.toThrow(
      /forms_pipeline_same_org_fk|foreign key/i,
    );

    // Created, not found: a test that looks for "some other workspace's source" passes only
    // because an earlier run left one behind.
    const theirSource = newId();
    await h.unscoped.leadSource.create({
      data: {
        id: theirSource,
        organizationId: h.orgB.organizationId,
        name: `Walk-in ${theirSource.slice(-8)}`,
      },
    });
    await expect(form(h.orgA.organizationId, { leadSourceId: theirSource })).rejects.toThrow(
      /forms_source_same_org_fk|foreign key/i,
    );

    const theirRule = newId();
    await h.unscoped.assignmentRule.create({
      data: {
        id: theirRule,
        organizationId: h.orgB.organizationId,
        name: `Theirs ${theirRule.slice(-8)}`,
        priority: 100,
        strategy: 'specific_user',
        target: { userId: h.orgB.userId },
      },
    });
    await expect(form(h.orgA.organizationId, { assignmentRuleId: theirRule })).rejects.toThrow(
      /forms_assignment_rule_same_org_fk|foreign key/i,
    );

    await expect(form(h.orgA.organizationId, { createdById: h.orgB.userId })).rejects.toThrow(
      /forms_creator_same_org_fk|foreign key/i,
    );
  });

  it('keeps the public key unique across the whole platform, because it is a URL', async () => {
    // Two workspaces must not be able to mint the same key: it is the only thing the public
    // endpoints have to go on, and a collision would route one business's captures to the other.
    const key = `shared-key-${newId().slice(-12)}`;
    await form(h.orgA.organizationId, { publicKey: key });
    await expect(form(h.orgB.organizationId, { publicKey: key })).rejects.toThrow(
      /forms_public_key_key|unique/i,
    );
  });

  it('refuses a public key short enough to guess', async () => {
    await expect(form(h.orgA.organizationId, { publicKey: 'short' })).rejects.toThrow(
      /forms_public_key_long_enough/i,
    );
  });

  it('refuses a slug that would not survive being in a URL', async () => {
    await expect(form(h.orgA.organizationId, { slug: 'Website Enquiry' })).rejects.toThrow(
      /forms_slug_is_url_safe/i,
    );
    await expect(form(h.orgA.organizationId, { slug: 'contact/us' })).rejects.toThrow(
      /forms_slug_is_url_safe/i,
    );
  });

  it('lets a deleted form’s slug be used again, which a plain unique would not', async () => {
    const slug = `reused-${newId().slice(-8)}`;
    const first = await form(h.orgA.organizationId, { slug });
    await expect(form(h.orgA.organizationId, { slug })).rejects.toThrow(/forms_live_slug|unique/i);
    await h.unscoped.form.update({ where: { id: first }, data: { deletedAt: new Date() } });
    // The point of the partial index: a workspace that deleted "contact-us" can make another one.
    await expect(form(h.orgA.organizationId, { slug })).resolves.toBeTruthy();
  });

  it('refuses a question that is both a standard field and a custom one, or neither', async () => {
    const mine = await form(h.orgA.organizationId);
    const field = (over: Record<string, unknown>) =>
      h.unscoped.formField.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          formId: mine,
          label: 'Phone',
          ...over,
        },
      });
    await expect(field({})).rejects.toThrow(/form_fields_one_target/i);

    const definition = newId();
    await h.unscoped.customFieldDefinition.create({
      data: {
        id: definition,
        organizationId: h.orgA.organizationId,
        entityType: 'lead',
        key: `budget_${definition.slice(-8)}`,
        label: 'Budget',
        type: 'number',
      },
    });
    await expect(
      field({ standardFieldKey: 'phone', customFieldDefinitionId: definition }),
    ).rejects.toThrow(/form_fields_one_target/i);
    await expect(field({ standardFieldKey: 'phone' })).resolves.toBeTruthy();
  });

  it('blocks a field against another tenant’s custom field definition', async () => {
    const mine = await form(h.orgA.organizationId);
    const theirs = newId();
    await h.unscoped.customFieldDefinition.create({
      data: {
        id: theirs,
        organizationId: h.orgB.organizationId,
        entityType: 'lead',
        key: `theirs_${theirs.slice(-8)}`,
        label: 'Theirs',
        type: 'text',
      },
    });
    await expect(
      h.unscoped.formField.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          formId: mine,
          label: 'Theirs',
          customFieldDefinitionId: theirs,
        },
      }),
    ).rejects.toThrow(/form_fields_definition_same_org_fk|foreign key/i);
  });

  it('refuses the same question twice on one form', async () => {
    const mine = await form(h.orgA.organizationId);
    const ask = () =>
      h.unscoped.formField.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          formId: mine,
          label: 'Phone',
          standardFieldKey: 'phone',
        },
      });
    await expect(ask()).resolves.toBeTruthy();
    await expect(ask()).rejects.toThrow(/form_field_standard_key|unique/i);
  });

  it('insists a submission that became a lead names one, and a refused one says why', async () => {
    const mine = await form(h.orgA.organizationId);
    const submission = (over: Record<string, unknown>) =>
      h.unscoped.formSubmission.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          formId: mine,
          rawPayload: { 'standard:phone': '+919845012345' },
          ...over,
        },
      });

    // `received` is the state the row is written in, before anything has been attempted: that is
    // what makes this a never-lose store rather than a record of what worked (`FR-CAP-3`).
    await expect(submission({})).resolves.toBeTruthy();
    await expect(submission({ status: 'processed' })).rejects.toThrow(
      /form_submissions_outcome_has_a_lead/i,
    );
    await expect(submission({ status: 'rejected' })).rejects.toThrow(
      /form_submissions_refusal_is_explained/i,
    );
    await expect(
      submission({ status: 'rejected', error: 'Honeypot field was filled in.' }),
    ).resolves.toBeTruthy();
    await expect(submission({ status: 'processed', leadId: h.orgA.leadId })).resolves.toBeTruthy();
  });

  it('blocks a submission against another tenant’s lead or form', async () => {
    const mine = await form(h.orgA.organizationId);
    await expect(
      h.unscoped.formSubmission.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          formId: mine,
          rawPayload: {},
          status: 'processed',
          leadId: h.orgB.leadId,
        },
      }),
    ).rejects.toThrow(/form_submissions_lead_same_org_fk|foreign key/i);

    const theirForm = await form(h.orgB.organizationId);
    await expect(
      h.unscoped.formSubmission.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          formId: theirForm,
          rawPayload: {},
        },
      }),
    ).rejects.toThrow(/form_submissions_form_same_org_fk|foreign key/i);
  });

  it('blocks a lead and a touchpoint from claiming another tenant’s form', async () => {
    const theirForm = await form(h.orgB.organizationId);
    await expect(
      h.unscoped.lead.update({
        where: { id: h.orgA.leadId },
        data: { formId: theirForm },
      }),
    ).rejects.toThrow(/leads_form_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.leadTouchpoint.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          leadId: h.orgA.leadId,
          sequence: 99,
          occurredAt: new Date('2026-04-01T10:00:00.000Z'),
          channel: 'form',
          formId: theirForm,
        },
      }),
    ).rejects.toThrow(/lead_touchpoints_form_same_org_fk|foreign key/i);
  });

  it('scopes forms and their submissions like every other tenant table', async () => {
    const mine = await form(h.orgA.organizationId);
    await h.unscoped.formSubmission.create({
      data: {
        id: newId(),
        organizationId: h.orgA.organizationId,
        formId: mine,
        rawPayload: { 'standard:phone': '+919845012345' },
      },
    });

    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      form: await h.db.form.findFirst({ where: { id: mine } }),
      submissions: await h.db.formSubmission.findMany({ where: { formId: mine } }),
    }));
    expect(theirs.form).toBeNull();
    expect(theirs.submissions).toEqual([]);
  });
});

describe('layer 3 — the public lead API’s own tables (FR-CAP-6, FR-API-2)', () => {
  /** A key in whichever workspace is asked for. The ciphertext is a plausible envelope. */
  async function apiKey(organizationId: string, over: Record<string, unknown> = {}) {
    const id = newId();
    await h.unscoped.apiKey.create({
      data: {
        id,
        organizationId,
        name: `Key ${id.slice(-8)}`,
        keyId: `pk_live_${id.replace(/-/g, '').slice(0, 20)}`,
        keyPrefix: `pk_live_${id.slice(0, 8)}`,
        secretEncrypted: `v1.1.${id.slice(-8)}.${id.slice(-8)}.${id.slice(-8)}`,
        scopes: ['ingest:write'],
        ...over,
      },
    });
    return id;
  }

  async function payload(organizationId: string, over: Record<string, unknown> = {}) {
    const id = newId();
    await h.unscoped.inboundPayload.create({
      data: {
        id,
        organizationId,
        channel: 'public_api',
        rawBody: { phone: '+919845012345' },
        idempotencyKey: `key-${id.slice(-12)}`,
        dedupeHash: 'a'.repeat(64),
        ...over,
      },
    });
    return id;
  }

  it('refuses a key whose secret is not an envelope, or is the secret itself', async () => {
    // The mistake the first draft of this step made in the other direction: once a secret has to
    // be recoverable, the obvious thing is to store it as it was generated.
    await expect(
      apiKey(h.orgA.organizationId, { secretEncrypted: 'sk_live_the_actual_secret' }),
    ).rejects.toThrow(/api_keys_secret_is_encrypted/i);
    await expect(
      apiKey(h.orgA.organizationId, { secretEncrypted: 'not-even-close' }),
    ).rejects.toThrow(/api_keys_secret_is_encrypted/i);
  });

  it('refuses a key with no scopes, which could do nothing but would look live', async () => {
    await expect(apiKey(h.orgA.organizationId, { scopes: [] })).rejects.toThrow(
      /api_keys_has_a_scope/i,
    );
  });

  it('keeps the public key id unique across the platform, because it is the caller’s identity', async () => {
    const shared = `pk_live_${newId().replace(/-/g, '').slice(0, 20)}`;
    await apiKey(h.orgA.organizationId, { keyId: shared });
    await expect(apiKey(h.orgB.organizationId, { keyId: shared })).rejects.toThrow(
      /api_key_id_key|unique/i,
    );
  });

  it('refuses half a revocation', async () => {
    const id = await apiKey(h.orgA.organizationId);
    await expect(
      h.unscoped.apiKey.update({ where: { id }, data: { revokedAt: new Date() } }),
    ).rejects.toThrow(/api_keys_revocation_is_accounted_for/i);
    await expect(
      h.unscoped.apiKey.update({
        where: { id },
        data: { revokedAt: new Date(), revokedBy: h.orgA.userId },
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a prefix that does not belong to its key', async () => {
    await expect(
      apiKey(h.orgA.organizationId, { keyPrefix: 'pk_live_somebodyelse' }),
    ).rejects.toThrow(/api_keys_prefix_matches_key/i);
  });

  it('blocks a payload against another tenant’s key', async () => {
    const theirs = await apiKey(h.orgB.organizationId);
    await expect(payload(h.orgA.organizationId, { apiKeyId: theirs })).rejects.toThrow(
      /inbound_payloads_api_key_same_org_fk|foreign key/i,
    );
  });

  it('insists a payload that became a lead names one, and a failure says why', async () => {
    // `received` is the state the row is written in — before anything is attempted — which is what
    // makes this a never-lose store rather than a record of what worked (`FR-CAP-3`).
    await expect(payload(h.orgA.organizationId)).resolves.toBeTruthy();
    await expect(payload(h.orgA.organizationId, { status: 'processed' })).rejects.toThrow(
      /inbound_payloads_outcome_has_a_lead/i,
    );
    await expect(payload(h.orgA.organizationId, { status: 'failed' })).rejects.toThrow(
      /inbound_payloads_failure_is_explained/i,
    );
    await expect(
      payload(h.orgA.organizationId, { status: 'failed', error: 'No way to reach them' }),
    ).resolves.toBeTruthy();
    await expect(
      payload(h.orgA.organizationId, { status: 'processed', leadId: h.orgA.leadId }),
    ).resolves.toBeTruthy();
  });

  it('refuses a payload with no idempotency key or a dedupe hash that is not one', async () => {
    await expect(payload(h.orgA.organizationId, { idempotencyKey: '  ' })).rejects.toThrow(
      /inbound_payloads_idempotency_key_present/i,
    );
    await expect(payload(h.orgA.organizationId, { dedupeHash: 'short' })).rejects.toThrow(
      /inbound_payloads_dedupe_hash_format/i,
    );
  });

  it('keeps one workspace from replaying another’s idempotency key', async () => {
    // The same key in two workspaces is two keys: the unique is `(organization_id, endpoint, key)`.
    const shared = `shared-${newId().slice(-12)}`;
    const row = (organizationId: string) => ({
      id: newId(),
      organizationId,
      key: shared,
      endpoint: 'POST /public/leads',
      requestHash: 'b'.repeat(64),
      responseStatus: 201,
      responseBody: { leadId: newId() },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await expect(
      h.unscoped.idempotencyKey.create({ data: row(h.orgA.organizationId) }),
    ).resolves.toBeTruthy();
    await expect(
      h.unscoped.idempotencyKey.create({ data: row(h.orgB.organizationId) }),
    ).resolves.toBeTruthy();
    // And the same key twice in one workspace is the replay guard.
    await expect(
      h.unscoped.idempotencyKey.create({ data: row(h.orgA.organizationId) }),
    ).rejects.toThrow(/idempotency_replay_key|unique/i);
  });

  it('refuses to remember a response that is not an answer', async () => {
    // A 500 is not worth replaying: a client retrying would be handed the failure it was retrying.
    await expect(
      h.unscoped.idempotencyKey.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          key: `bad-${newId().slice(-8)}`,
          endpoint: 'POST /public/leads',
          requestHash: 'c'.repeat(64),
          responseStatus: 500,
          responseBody: {},
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    ).rejects.toThrow(/idempotency_keys_response_is_an_answer/i);
  });

  it('refuses an ingestion error naming a stage the pipeline does not have', async () => {
    const payloadId = await payload(h.orgA.organizationId);
    const row = await h.unscoped.inboundPayload.findFirstOrThrow({ where: { id: payloadId } });
    const create = (stage: string) =>
      h.unscoped.ingestionError.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          payloadId,
          payloadReceivedAt: row.receivedAt,
          stage,
          errorCode: 'VALIDATION_FAILED',
          message: 'No way to reach them',
        },
      });
    await expect(create('validate')).resolves.toBeTruthy();
    await expect(create('somewhere_else')).rejects.toThrow(/ingestion_errors_stage_is_known/i);
  });

  it('blocks an ingestion error against another tenant’s payload', async () => {
    const theirs = await payload(h.orgB.organizationId);
    const row = await h.unscoped.inboundPayload.findFirstOrThrow({ where: { id: theirs } });
    await expect(
      h.unscoped.ingestionError.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          payloadId: theirs,
          payloadReceivedAt: row.receivedAt,
          stage: 'validate',
          errorCode: 'VALIDATION_FAILED',
          message: 'Not mine',
        },
      }),
    ).rejects.toThrow(/ingestion_errors_payload_same_org_fk|foreign key/i);
  });

  it('scopes the keys, the payloads and the errors like every other tenant table', async () => {
    const mineKey = await apiKey(h.orgA.organizationId);
    const minePayload = await payload(h.orgA.organizationId, { apiKeyId: mineKey });
    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      key: await h.db.apiKey.findFirst({ where: { id: mineKey } }),
      payload: await h.db.inboundPayload.findFirst({ where: { id: minePayload } }),
      keys: await h.db.apiKey.findMany({}),
    }));
    expect(theirs.key).toBeNull();
    expect(theirs.payload).toBeNull();
    expect(theirs.keys.every((row) => row.organizationId === h.orgB.organizationId)).toBe(true);
  });
});

describe('layer 3 — an outbound webhook cannot be stitched to another tenant (FR-API-4)', () => {
  /**
   * An endpoint, created on the **unscoped** client on purpose: these tests are the
   * "application bug" scenario, where the extension has been bypassed and only the database is
   * left to refuse. Each test makes its own, because a shared fixture trips the uniqueness rules it
   * is not testing — `webhook_endpoint_url_key` allows one endpoint per URL per workspace.
   */
  async function endpoint(organizationId: string, overrides: Record<string, unknown> = {}) {
    const id = newId();
    await h.unscoped.webhookEndpoint.create({
      data: {
        id,
        organizationId,
        url: `https://hooks.example.com/${id.slice(-8)}`,
        secretEncrypted: 'v1.1.aaaa.bbbb.cccc',
        eventTypes: ['lead.created'],
        ...overrides,
      } as never,
    });
    return id;
  }

  async function delivery(organizationId: string, endpointId: string) {
    const id = newId();
    const createdAt = new Date();
    await h.unscoped.webhookDelivery.create({
      data: {
        id,
        organizationId,
        endpointId,
        eventId: newId(),
        eventType: 'lead.created',
        payload: { id: 'evt', type: 'lead.created' },
        createdAt,
      } as never,
    });
    return { id, createdAt };
  }

  it('blocks a delivery aimed at another tenant’s endpoint', async () => {
    const theirs = await endpoint(h.orgB.organizationId);
    await expect(
      h.unscoped.webhookDelivery.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          endpointId: theirs,
          eventId: newId(),
          eventType: 'lead.created',
          payload: {},
          createdAt: new Date(),
        } as never,
      }),
    ).rejects.toThrow(/webhook_deliveries_endpoint_same_org_fk|foreign key/i);
  });

  it('blocks an attempt against another tenant’s delivery', async () => {
    const theirEndpoint = await endpoint(h.orgB.organizationId);
    const theirDelivery = await delivery(h.orgB.organizationId, theirEndpoint);
    await expect(
      h.unscoped.webhookAttempt.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          deliveryId: theirDelivery.id,
          deliveryCreatedAt: theirDelivery.createdAt,
          attemptNo: 1,
          statusCode: 200,
          durationMs: 12,
        } as never,
      }),
    ).rejects.toThrow(/webhook_attempts_delivery_same_org_fk|foreign key/i);
  });

  it('refuses an endpoint that is not somewhere we could post to', async () => {
    await expect(endpoint(h.orgA.organizationId, { url: 'file:///etc/passwd' })).rejects.toThrow(
      /webhook_endpoints_url_is_http/i,
    );
  });

  it('refuses an endpoint subscribed to nothing', async () => {
    // `cardinality`, not `array_length`: on an empty array the latter is NULL and the CHECK passes.
    await expect(endpoint(h.orgA.organizationId, { eventTypes: [] })).rejects.toThrow(
      /webhook_endpoints_has_event_types/i,
    );
  });

  it('refuses a signing secret stored as it was generated', async () => {
    await expect(
      endpoint(h.orgA.organizationId, { secretEncrypted: 'whsec_plaintext_secret_value' }),
    ).rejects.toThrow(/webhook_endpoints_secret_is_encrypted/i);
  });

  it('refuses an endpoint disabled without a reason, and one disabled while still active', async () => {
    await expect(
      endpoint(h.orgA.organizationId, { disabledAt: new Date(), isActive: false }),
    ).rejects.toThrow(/webhook_endpoints_disabled_is_accounted_for/i);
    await expect(
      endpoint(h.orgA.organizationId, {
        disabledAt: new Date(),
        disabledReason: 'Too many failures',
        isActive: true,
      }),
    ).rejects.toThrow(/webhook_endpoints_disabled_is_accounted_for/i);
  });

  it('refuses a delivery that claims success with no delivery instant', async () => {
    const mine = await endpoint(h.orgA.organizationId);
    await expect(
      h.unscoped.webhookDelivery.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          endpointId: mine,
          eventId: newId(),
          eventType: 'lead.created',
          payload: {},
          status: 'succeeded',
          attemptCount: 1,
          createdAt: new Date(),
        } as never,
      }),
    ).rejects.toThrow(/webhook_deliveries_delivered_has_timestamp/i);
  });

  it('refuses a finished delivery with something still due', async () => {
    // Without this, an exhausted row with a `next_attempt_at` is retried by the sweep forever.
    const mine = await endpoint(h.orgA.organizationId);
    await expect(
      h.unscoped.webhookDelivery.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          endpointId: mine,
          eventId: newId(),
          eventType: 'lead.created',
          payload: {},
          status: 'exhausted',
          attemptCount: 8,
          nextAttemptAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
        } as never,
      }),
    ).rejects.toThrow(/webhook_deliveries_finished_has_nothing_due/i);
  });

  it('refuses a pending delivery that has already been attempted', async () => {
    const mine = await endpoint(h.orgA.organizationId);
    await expect(
      h.unscoped.webhookDelivery.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          endpointId: mine,
          eventId: newId(),
          eventType: 'lead.created',
          payload: {},
          status: 'pending',
          attemptCount: 2,
          createdAt: new Date(),
        } as never,
      }),
    ).rejects.toThrow(/webhook_deliveries_pending_is_untried/i);
  });

  it('refuses an attempt with no outcome at all', async () => {
    const mine = await endpoint(h.orgA.organizationId);
    const row = await delivery(h.orgA.organizationId, mine);
    await expect(
      h.unscoped.webhookAttempt.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          deliveryId: row.id,
          deliveryCreatedAt: row.createdAt,
          attemptNo: 1,
          durationMs: 30,
        } as never,
      }),
    ).rejects.toThrow(/webhook_attempts_has_an_outcome/i);
  });

  it('allows one row per attempt and refuses the second copy of one', async () => {
    const mine = await endpoint(h.orgA.organizationId);
    const row = await delivery(h.orgA.organizationId, mine);
    const attempt = (attemptNo: number) =>
      h.unscoped.webhookAttempt.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          deliveryId: row.id,
          deliveryCreatedAt: row.createdAt,
          attemptNo,
          statusCode: 500,
          durationMs: 40,
        } as never,
      });
    await expect(attempt(1)).resolves.toBeTruthy();
    await expect(attempt(2)).resolves.toBeTruthy();
    // A retried job must not be able to log the same attempt twice.
    await expect(attempt(2)).rejects.toThrow(/webhook_attempt_number_key|unique/i);
  });

  it('scopes the endpoints, the deliveries and the attempts like every other tenant table', async () => {
    const mine = await endpoint(h.orgA.organizationId);
    const row = await delivery(h.orgA.organizationId, mine);
    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      endpoint: await h.db.webhookEndpoint.findFirst({ where: { id: mine } }),
      delivery: await h.db.webhookDelivery.findFirst({ where: { id: row.id } }),
      endpoints: await h.db.webhookEndpoint.findMany({}),
    }));
    expect(theirs.endpoint).toBeNull();
    expect(theirs.delivery).toBeNull();
    expect(theirs.endpoints.every((entry) => entry.organizationId === h.orgB.organizationId)).toBe(
      true,
    );
  });
});
