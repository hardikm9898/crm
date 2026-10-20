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

describe('layer 3 — the request log (FR-API-1, FR-SA-4)', () => {
  /** A key in whichever workspace is asked for, so a log row has something to point at. */
  async function apiKey(organizationId: string) {
    const id = newId();
    await h.unscoped.apiKey.create({
      data: {
        id,
        organizationId,
        name: `Key ${id.slice(-8)}`,
        keyId: `pk_live_${id.replace(/-/g, '').slice(0, 20)}`,
        keyPrefix: `pk_live_${id.slice(0, 8)}`,
        secretEncrypted: `v1.1.${id.slice(-8)}.${id.slice(-8)}.${id.slice(-8)}`,
        scopes: ['lead:read'],
      },
    });
    return id;
  }

  async function logRow(organizationId: string, over: Record<string, unknown> = {}) {
    const id = newId();
    const createdAt = new Date();
    await h.unscoped.apiLog.create({
      data: {
        id,
        organizationId,
        surface: 'rest',
        method: 'GET',
        path: '/api/v1/leads',
        statusCode: 200,
        durationMs: 12,
        requestId: `req_${id}`,
        createdAt,
        ...over,
      } as never,
    });
    return { id, createdAt };
  }

  it('refuses a row naming another workspace’s key', async () => {
    const theirKey = await apiKey(h.orgB.organizationId);
    // The composite FK, not an application check: a log row that claims somebody else's
    // credential made the request would be a lie about who did what.
    await expect(
      logRow(h.orgA.organizationId, { apiKeyId: theirKey }),
    ).rejects.toThrow(/api_logs_api_key_same_org_fk|foreign key/i);
  });

  it('refuses a verb this API does not answer, and a URL instead of a path', async () => {
    await expect(logRow(h.orgA.organizationId, { method: 'TRACE' })).rejects.toThrow(
      /api_logs_method_is_a_verb/i,
    );
    await expect(
      logRow(h.orgA.organizationId, { path: 'https://leados.test/api/v1/leads' }),
    ).rejects.toThrow(/api_logs_path_is_a_path/i);
    // The query string is dropped by `logPath` before the row is written; the constraint is what
    // makes "something else wrote this row" impossible rather than merely unlikely.
    await expect(
      logRow(h.orgA.organizationId, { path: '/api/v1/leads?search=asha' }),
    ).rejects.toThrow(/api_logs_path_is_a_path/i);
  });

  it('refuses a measurement that cannot be true, and an answer that succeeded with an error code', async () => {
    await expect(logRow(h.orgA.organizationId, { durationMs: -1 })).rejects.toThrow(
      /api_logs_measurements_sane/i,
    );
    await expect(logRow(h.orgA.organizationId, { statusCode: 99 })).rejects.toThrow(
      /api_logs_status_is_http/i,
    );
    await expect(
      logRow(h.orgA.organizationId, { statusCode: 200, errorCode: 'NOT_FOUND' }),
    ).rejects.toThrow(/api_logs_success_has_no_error_code/i);
    // The honest state the mirror of that CHECK would have forbidden: a refusal Fastify answered
    // before any envelope existed, and therefore without a code.
    await expect(
      logRow(h.orgA.organizationId, { statusCode: 404, errorCode: null }),
    ).resolves.toBeTruthy();
  });

  it('shows each workspace only its own requests', async () => {
    const mine = await logRow(h.orgA.organizationId);
    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      row: await h.db.apiLog.findFirst({ where: { id: mine.id } }),
      all: await h.db.apiLog.findMany({}),
    }));
    expect(theirs.row).toBeNull();
    expect(theirs.all.every((entry) => entry.organizationId === h.orgB.organizationId)).toBe(true);
  });
});

describe('layer 3 — the integration framework (Phase 4 step 6)', () => {
  /** A connection in whichever workspace is asked for, with a plausible envelope. */
  async function connection(organizationId: string, over: Record<string, unknown> = {}) {
    const id = newId();
    await h.unscoped.integrationConnection.create({
      data: {
        id,
        organizationId,
        provider: 'generic_webhook',
        name: `Partner ${id.slice(-8)}`,
        credentialsEncrypted: `v1.1.${id.slice(-8)}.${id.slice(-8)}.${id.slice(-8)}`,
        scopes: [],
        ...over,
      } as never,
    });
    return id;
  }

  it('refuses a credential stored as the provider gave it', async () => {
    // The mistake ADR-0030 found late, in a new table: a token kept as plaintext because it
    // "needs to be sent as-is".
    await expect(
      connection(h.orgA.organizationId, { credentialsEncrypted: 'sk_postmark_server_token' }),
    ).rejects.toThrow(/integration_connections_credentials_encrypted/i);
    await expect(
      connection(h.orgA.organizationId, { credentialsEncrypted: 'whsec_not_this_either' }),
    ).rejects.toThrow(/integration_connections_credentials_encrypted/i);
  });

  it('refuses a provider key that is prose, and a key version below one', async () => {
    await expect(connection(h.orgA.organizationId, { provider: 'Meta Ads' })).rejects.toThrow(
      /integration_connections_provider_is_a_key/i,
    );
    await expect(connection(h.orgA.organizationId, { keyVersion: 0 })).rejects.toThrow(
      /integration_connections_key_version_positive/i,
    );
  });

  it('allows one live connection per provider, and a second after the first is disconnected', async () => {
    await connection(h.orgA.organizationId, { provider: 'postmark' });
    await expect(
      connection(h.orgA.organizationId, { provider: 'postmark' }),
    ).rejects.toThrow(/integration_connections_live_provider|unique/i);

    // Disconnecting has to free the provider, or a workspace that switched Postmark off could
    // never switch it back on — which is what a plain `@@unique` would have done.
    await h.unscoped.integrationConnection.updateMany({
      where: { organizationId: h.orgA.organizationId, provider: 'postmark' },
      data: { disconnectedAt: new Date(), status: 'revoked' },
    });
    await expect(
      connection(h.orgA.organizationId, { provider: 'postmark' }),
    ).resolves.toBeTruthy();

    // And another workspace was never blocked by ours.
    await expect(connection(h.orgB.organizationId, { provider: 'postmark' })).resolves.toBeTruthy();
  });

  it('refuses a disconnected connection that still claims to be connected', async () => {
    await expect(
      connection(h.orgA.organizationId, { provider: 'disconnected_test', disconnectedAt: new Date() }),
    ).rejects.toThrow(/integration_connections_disconnected_is_not_connected/i);
  });

  it('refuses a mapping stored as an object and settings stored as a list', async () => {
    // A mapping as `{}` reads as "no mapping" to code that iterates and as "a mapping" to code
    // that checks for the key.
    await expect(
      connection(h.orgA.organizationId, { provider: 'mapping_test', fieldMappings: {} }),
    ).rejects.toThrow(/integration_connections_mappings_are_a_list/i);
    await expect(
      connection(h.orgA.organizationId, { provider: 'settings_test', settings: [] }),
    ).rejects.toThrow(/integration_connections_settings_are_an_object/i);
  });

  it('refuses a cursor or a health check pointed at another workspace’s connection', async () => {
    const theirs = await connection(h.orgB.organizationId, { provider: 'cross_tenant_test' });
    await expect(
      h.unscoped.syncCursor.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          connectionId: theirs,
          resource: 'leads',
        } as never,
      }),
    ).rejects.toThrow(/sync_cursors_connection_same_org_fk|foreign key/i);

    await expect(
      h.unscoped.integrationHealthCheck.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          connectionId: theirs,
          outcome: 'ok',
          latencyMs: 12,
        } as never,
      }),
    ).rejects.toThrow(/integration_health_checks_connection_same_org_fk|foreign key/i);
  });

  it('insists a probe that succeeded was timed, and refuses an outcome nothing can read', async () => {
    const mine = await connection(h.orgA.organizationId, { provider: 'probe_test' });
    const check = (over: Record<string, unknown>) =>
      h.unscoped.integrationHealthCheck.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          connectionId: mine,
          outcome: 'ok',
          latencyMs: 20,
          ...over,
        } as never,
      });
    await expect(check({ outcome: 'flaky' })).rejects.toThrow(
      /integration_health_checks_outcome_is_known/i,
    );
    await expect(check({ latencyMs: -1 })).rejects.toThrow(
      /integration_health_checks_latency_sane/i,
    );
    await expect(check({ outcome: 'ok', latencyMs: null })).rejects.toThrow(
      /integration_health_checks_ok_was_timed/i,
    );
    // The honest state the mirror would have forbidden: nothing reached, so nothing timed.
    await expect(check({ outcome: 'unreachable', latencyMs: null })).resolves.toBeTruthy();
  });

  it('allows one cursor per resource per connection, and scopes the lot', async () => {
    const mine = await connection(h.orgA.organizationId, { provider: 'cursor_test' });
    const cursor = () =>
      h.unscoped.syncCursor.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          connectionId: mine,
          resource: 'leads',
        } as never,
      });
    await expect(cursor()).resolves.toBeTruthy();
    await expect(cursor()).rejects.toThrow(/sync_cursor_resource_key|unique/i);

    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      connection: await h.db.integrationConnection.findFirst({ where: { id: mine } }),
      cursors: await h.db.syncCursor.findMany({}),
      checks: await h.db.integrationHealthCheck.findMany({}),
    }));
    expect(theirs.connection).toBeNull();
    expect(theirs.cursors.every((row) => row.organizationId === h.orgB.organizationId)).toBe(true);
    expect(theirs.checks.every((row) => row.organizationId === h.orgB.organizationId)).toBe(true);
  });
});

describe('layer 4 — the inbound idempotency ledger (Phase 4 step 7)', () => {
  async function connection(organizationId: string, provider: string) {
    const id = newId();
    await h.unscoped.integrationConnection.create({
      data: {
        id,
        organizationId,
        provider,
        name: `Ads ${id.slice(-8)}`,
        credentialsEncrypted: `v1.1.${id.slice(-8)}.${id.slice(-8)}.${id.slice(-8)}`,
        scopes: [],
      } as never,
    });
    return id;
  }

  /** One event in whichever workspace is asked for. */
  async function event(
    organizationId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const id = newId();
    await h.unscoped.providerEvent.create({
      data: {
        id,
        organizationId,
        provider: 'meta_lead_ads',
        externalEventId: `leadgen_${id.slice(-10)}`,
        eventType: 'leadgen',
        raw: { leadgen_id: id.slice(-10) },
        ...over,
      } as never,
    });
    return id;
  }

  it('makes a second delivery of the same event impossible, per workspace', async () => {
    // The guarantee the exit criterion is about: Meta retries a delivery it did not get a 200 for,
    // and the **database** is what stops the second lead rather than a check somebody remembered.
    const external = `leadgen_${newId().slice(-10)}`;
    await expect(event(h.orgA.organizationId, { externalEventId: external })).resolves.toBeTruthy();
    await expect(event(h.orgA.organizationId, { externalEventId: external })).rejects.toThrow(
      /provider_event_external_key|unique/i,
    );

    // Two providers can legitimately use the same id, and so can two workspaces: the unique is
    // `(organization_id, provider, external_event_id)`, not the id alone.
    await expect(
      event(h.orgA.organizationId, { externalEventId: external, provider: 'google_ads_leads' }),
    ).resolves.toBeTruthy();
    await expect(event(h.orgB.organizationId, { externalEventId: external })).resolves.toBeTruthy();
  });

  it('refuses an event pointed at another workspace’s connection', async () => {
    const theirs = await connection(h.orgB.organizationId, 'meta_lead_ads');
    await expect(
      event(h.orgA.organizationId, { connectionId: theirs }),
    ).rejects.toThrow(/provider_events_connection_same_org_fk|foreign key/i);

    // And our own is accepted, so the refusal above is about the tenant and not about the column.
    const mine = await connection(h.orgA.organizationId, 'meta_lead_ads');
    await expect(event(h.orgA.organizationId, { connectionId: mine })).resolves.toBeTruthy();
  });

  it('refuses a provider key that is prose and an external id that is empty', async () => {
    await expect(event(h.orgA.organizationId, { provider: 'Meta Lead Ads' })).rejects.toThrow(
      /provider_events_provider_is_a_key/i,
    );
    // An empty id would make every event from a provider that forgot to send one collide with the
    // first — which is the unique working exactly as designed against a meaningless key.
    await expect(event(h.orgA.organizationId, { externalEventId: '' })).rejects.toThrow(
      /provider_events_external_id_present/i,
    );
  });

  it('insists an event that became a lead says when it was processed', async () => {
    await expect(
      event(h.orgA.organizationId, { leadId: newId(), status: 'received' }),
    ).rejects.toThrow(/provider_events_lead_was_processed/i);
    await expect(
      event(h.orgA.organizationId, { leadId: newId(), status: 'processed' }),
    ).rejects.toThrow(/provider_events_lead_was_processed/i);
    await expect(
      event(h.orgA.organizationId, {
        leadId: newId(),
        status: 'processed',
        processedAt: new Date(),
        attempts: 1,
      }),
    ).resolves.toBeTruthy();

    // The honest state the mirror would have forbidden: processed, and the duplicate rules attached
    // it to a lead that already existed, so this event produced none of its own.
    await expect(
      event(h.orgA.organizationId, {
        status: 'processed',
        processedAt: new Date(),
        attempts: 1,
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a received event that claims to have been tried', async () => {
    await expect(event(h.orgA.organizationId, { attempts: 1 })).rejects.toThrow(
      /provider_events_received_is_untried/i,
    );
    // And the state a connection switched off between the delivery and the attempt leaves behind,
    // which the biconditional would have made unrepresentable.
    await expect(
      event(h.orgA.organizationId, { status: 'failed', attempts: 0, error: 'the connection was off' }),
    ).resolves.toBeTruthy();
  });

  it('keeps one workspace’s ledger invisible to another', async () => {
    const mine = await event(h.orgA.organizationId);
    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      one: await h.db.providerEvent.findFirst({ where: { id: mine } }),
      all: await h.db.providerEvent.findMany({}),
    }));
    expect(theirs.one).toBeNull();
    expect(theirs.all.every((row) => row.organizationId === h.orgB.organizationId)).toBe(true);
  });
});

describe('layer 5 — WhatsApp conversations and messages (Phase 5 step 1)', () => {
  /**
   * One connection per workspace, memoised.
   *
   * `integration_connections_live_provider` allows one live connection per provider, which is the
   * point of that partial unique — so a helper that minted a fresh one per call failed on the
   * constraint it was not testing, the same lesson the SLA fixture learnt one layer up.
   */
  const connections = new Map<string, string>();
  async function connectionFor(organizationId: string): Promise<string> {
    const existing = connections.get(organizationId);
    if (existing !== undefined) return existing;
    const connectionId = newId();
    await h.unscoped.integrationConnection.create({
      data: {
        id: connectionId,
        organizationId,
        provider: 'whatsapp_cloud',
        name: `WABA ${connectionId.slice(-8)}`,
        credentialsEncrypted: `v1.1.${connectionId.slice(-8)}.${connectionId.slice(-8)}.${connectionId.slice(-8)}`,
        scopes: [],
      } as never,
    });
    connections.set(organizationId, connectionId);
    return connectionId;
  }

  /** An account and a number in whichever workspace is asked for. */
  async function number(organizationId: string, over: Record<string, unknown> = {}) {
    const connectionId = await connectionFor(organizationId);
    const accountId = newId();
    await h.unscoped.whatsAppAccount.create({
      data: {
        id: accountId,
        organizationId,
        integrationConnectionId: connectionId,
        wabaId: `waba_${accountId.slice(-10)}`,
      } as never,
    });
    const numberId = newId();
    await h.unscoped.whatsAppNumber.create({
      data: {
        id: numberId,
        organizationId,
        accountId,
        phoneNumberId: `pn_${numberId.slice(-10)}`,
        displayPhoneE164: '+919845000000',
        ...over,
      } as never,
    });
    return { numberId, accountId, connectionId };
  }

  async function conversation(
    organizationId: string,
    channelAccountId: string,
    over: Record<string, unknown> = {},
  ) {
    const id = newId();
    await h.unscoped.conversation.create({
      data: {
        id,
        organizationId,
        channel: 'whatsapp',
        channelAccountId,
        contactE164: '+919845012345',
        ...over,
      } as never,
    });
    return id;
  }

  it('refuses a number that is not E.164, and an unread count below nothing', async () => {
    const own = await number(h.orgA.organizationId);
    await expect(
      number(h.orgA.organizationId, { displayPhoneE164: '9845000000' }),
    ).rejects.toThrow(/whatsapp_numbers_display_phone_e164/i);
    await expect(
      conversation(h.orgA.organizationId, own.numberId, { contactE164: 'ring me' }),
    ).rejects.toThrow(/conversations_contact_e164/i);
    await expect(
      conversation(h.orgA.organizationId, own.numberId, { unreadCount: -1 }),
    ).rejects.toThrow(/conversations_unread_count_sane/i);
  });

  it('makes one business number unclaimable by a second workspace', async () => {
    // Globally unique, not per workspace: an inbound delivery carries only this id, so two
    // workspaces claiming it would make resolving the tenant a guess — and a guess here delivers
    // somebody's customer's message to the wrong business.
    const mine = await number(h.orgA.organizationId);
    const taken = await h.unscoped.whatsAppNumber.findFirstOrThrow({
      where: { id: mine.numberId },
      select: { phoneNumberId: true },
    });
    await expect(
      number(h.orgB.organizationId, { phoneNumberId: taken.phoneNumberId }),
    ).rejects.toThrow(/phone_number_id|unique/i);
  });

  it('refuses a conversation on another workspace’s number, and a message on another’s conversation', async () => {
    const theirs = await number(h.orgB.organizationId);
    await expect(conversation(h.orgA.organizationId, theirs.numberId)).rejects.toThrow(
      /conversations_number_same_org_fk|foreign key/i,
    );

    const mine = await number(h.orgA.organizationId);
    const theirConversation = await conversation(h.orgB.organizationId, theirs.numberId);
    await expect(
      h.unscoped.message.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: theirConversation,
          direction: 'inbound',
          type: 'text',
          body: 'hello',
        } as never,
      }),
    ).rejects.toThrow(/messages_conversation_same_org_fk|foreign key/i);

    // And our own is accepted, so the refusals above are about the tenant and not the column.
    const ours = await conversation(h.orgA.organizationId, mine.numberId);
    await expect(
      h.unscoped.message.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: ours,
          direction: 'inbound',
          type: 'text',
          body: 'hello',
        } as never,
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses an inbound message that claims one of our people sent it', async () => {
    // A row claiming a sender would put a colleague's name on a customer's words.
    const mine = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, mine.numberId);
    await expect(
      h.unscoped.message.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: ours,
          direction: 'inbound',
          type: 'text',
          body: 'hello',
          senderUserId: h.orgA.userId,
        } as never,
      }),
    ).rejects.toThrow(/messages_inbound_has_no_sender/i);
  });

  it('insists a failed message says why, and a closed conversation says when', async () => {
    const mine = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, mine.numberId);
    const message = (over: Record<string, unknown>) =>
      h.unscoped.message.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: ours,
          direction: 'outbound',
          type: 'text',
          body: 'hello',
          ...over,
        } as never,
      });
    await expect(message({ status: 'failed' })).rejects.toThrow(/messages_failed_says_why/i);
    await expect(
      message({ status: 'failed', failedAt: new Date(), errorCode: '131047' }),
    ).resolves.toBeTruthy();
    // The honest state the mirror would have forbidden: it failed once and the resend worked.
    await expect(message({ status: 'sent', failedAt: new Date() })).resolves.toBeTruthy();

    await expect(
      conversation(h.orgA.organizationId, mine.numberId, { status: 'closed' }),
    ).rejects.toThrow(/conversations_closed_says_when/i);
    await expect(
      conversation(h.orgA.organizationId, mine.numberId, {
        status: 'closed',
        closedAt: new Date(),
      }),
    ).resolves.toBeTruthy();
  });

  it('insists a 24-hour window has a message to count from', async () => {
    const mine = await number(h.orgA.organizationId);
    await expect(
      conversation(h.orgA.organizationId, mine.numberId, { windowExpiresAt: new Date() }),
    ).rejects.toThrow(/conversations_window_needs_inbound/i);
    const inbound = new Date();
    await expect(
      conversation(h.orgA.organizationId, mine.numberId, {
        lastInboundAt: inbound,
        windowExpiresAt: new Date(inbound.getTime() + 86_400_000),
      }),
    ).resolves.toBeTruthy();
    // The honest state the mirror would have forbidden: the window was cleared and the message
    // somebody sent is still the last thing they said.
    await expect(
      conversation(h.orgA.organizationId, mine.numberId, { lastInboundAt: inbound }),
    ).resolves.toBeTruthy();
  });

  it('makes a redelivered provider message id impossible within the month', async () => {
    const mine = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, mine.numberId);
    const wamid = `wamid.${newId().slice(-12)}`;
    const createdAt = new Date();
    const message = (organizationId: string, conversationId: string) =>
      h.unscoped.message.create({
        data: {
          id: newId(),
          organizationId,
          conversationId,
          direction: 'inbound',
          type: 'text',
          body: 'hello',
          providerMessageId: wamid,
          createdAt,
        } as never,
      });
    await expect(message(h.orgA.organizationId, ours)).resolves.toBeTruthy();
    // The race guard, and it is **global**: the same `wamid` in another workspace is still the
    // same message, and Meta's ids are unique across every business.
    await expect(message(h.orgA.organizationId, ours)).rejects.toThrow(
      /messages_provider_message_unique|unique/i,
    );
    const theirs = await number(h.orgB.organizationId);
    const theirConversation = await conversation(h.orgB.organizationId, theirs.numberId);
    await expect(message(h.orgB.organizationId, theirConversation)).rejects.toThrow(
      /messages_provider_message_unique|unique/i,
    );
  });

  it('allows as many unsent outbound messages as somebody writes', async () => {
    // A complete unique on `(provider, provider_message_id)` would allow exactly one message with
    // no provider id per month, which is every message before Meta accepts it.
    const mine = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, mine.numberId);
    const queued = () =>
      h.unscoped.message.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: ours,
          direction: 'outbound',
          type: 'text',
          body: 'hello',
          status: 'queued',
        } as never,
      });
    await expect(queued()).resolves.toBeTruthy();
    await expect(queued()).resolves.toBeTruthy();
  });

  it('keeps one workspace’s conversations and messages invisible to another', async () => {
    const mine = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, mine.numberId);
    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      one: await h.db.conversation.findFirst({ where: { id: ours } }),
      conversations: await h.db.conversation.findMany({}),
      messages: await h.db.message.findMany({}),
      numbers: await h.db.whatsAppNumber.findMany({}),
      accounts: await h.db.whatsAppAccount.findMany({}),
    }));
    expect(theirs.one).toBeNull();
    for (const [label, rows] of Object.entries({
      conversations: theirs.conversations,
      messages: theirs.messages,
      numbers: theirs.numbers,
      accounts: theirs.accounts,
    })) {
      expect(
        rows.every((row) => row.organizationId === h.orgB.organizationId),
        label,
      ).toBe(true);
    }
  });

  // ── Phase 5 step 2 — templates and status receipts ───────────────────────

  async function template(organizationId: string, over: Record<string, unknown> = {}) {
    const own = await number(organizationId);
    const id = newId();
    await h.unscoped.whatsAppTemplate.create({
      data: {
        id,
        organizationId,
        accountId: own.accountId,
        name: `order_update_${id.slice(-8)}`,
        language: 'en',
        category: 'utility',
        components: { body: 'Hello {{1}}' },
        ...over,
      } as never,
    });
    return { id, accountId: own.accountId, numberId: own.numberId };
  }

  it('refuses a template name or language WhatsApp would refuse', async () => {
    const own = await number(h.orgA.organizationId);
    const create = (over: Record<string, unknown>) =>
      h.unscoped.whatsAppTemplate.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          accountId: own.accountId,
          name: 'order_update',
          language: 'en',
          category: 'utility',
          components: { body: 'Hello' },
          ...over,
        } as never,
      });
    await expect(create({ name: 'Order Update' })).rejects.toThrow(
      /whatsapp_templates_name_shape/i,
    );
    await expect(create({ name: 'ab' })).rejects.toThrow(/whatsapp_templates_name_shape/i);
    await expect(create({ language: 'english' })).rejects.toThrow(
      /whatsapp_templates_language_shape/i,
    );
    // The length is a `length()` test rather than `{3,512}`, because Postgres refuses a regex
    // repetition count above 255 — so this, which is 300 characters, has to be accepted.
    await expect(create({ name: 'a'.repeat(300) })).resolves.toBeTruthy();
  });

  it('insists a rejected template says why, and that anything Meta has seen has Meta’s id', async () => {
    const own = await number(h.orgA.organizationId);
    const create = (over: Record<string, unknown>) =>
      h.unscoped.whatsAppTemplate.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          accountId: own.accountId,
          name: `t_${newId().slice(-8)}`,
          language: 'en',
          category: 'utility',
          components: { body: 'Hello' },
          ...over,
        } as never,
      });
    await expect(create({ status: 'rejected', providerTemplateId: 'meta-1' })).rejects.toThrow(
      /whatsapp_templates_rejected_says_why/i,
    );
    await expect(create({ status: 'approved' })).rejects.toThrow(
      /whatsapp_templates_submitted_has_provider_id/i,
    );
    // The honest state the mirror would have forbidden: a resubmitted template keeps the reason it
    // was refused for last time, which is the thing the person editing it needs to read.
    await expect(
      create({ status: 'pending', providerTemplateId: 'meta-2', rejectionReason: 'Too promotional' }),
    ).resolves.toBeTruthy();
    await expect(create({ components: 'not an object' })).rejects.toThrow(
      /components_is_an_object|invalid input/i,
    );
  });

  it('refuses a template on another workspace’s account, and a message naming another’s template', async () => {
    const theirs = await template(h.orgB.organizationId);
    const mine = await number(h.orgA.organizationId);
    await expect(
      h.unscoped.whatsAppTemplate.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          accountId: theirs.accountId,
          name: `t_${newId().slice(-8)}`,
          language: 'en',
          category: 'utility',
          components: { body: 'Hello' },
        } as never,
      }),
    ).rejects.toThrow(/whatsapp_templates_account_same_org_fk|foreign key/i);

    const ours = await conversation(h.orgA.organizationId, mine.numberId);
    await expect(
      h.unscoped.message.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: ours,
          direction: 'outbound',
          type: 'template',
          templateId: theirs.id,
        } as never,
      }),
    ).rejects.toThrow(/messages_template_same_org_fk|foreign key/i);
  });

  it('insists a message naming a template is a template, and that inbound is never sent', async () => {
    const own = await template(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, own.numberId);
    const message = (over: Record<string, unknown>) =>
      h.unscoped.message.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: ours,
          direction: 'outbound',
          type: 'text',
          body: 'hello',
          ...over,
        } as never,
      });
    await expect(message({ templateId: own.id })).rejects.toThrow(
      /messages_template_id_is_a_template/i,
    );
    await expect(message({ type: 'template', templateId: own.id })).resolves.toBeTruthy();
    // The mirror is false and deliberately not asserted: a `template` message with no local
    // template is one Meta reports for wording this product has never stored.
    await expect(message({ type: 'template' })).resolves.toBeTruthy();

    await expect(message({ direction: 'inbound', sendAttempts: 1 })).rejects.toThrow(
      /messages_send_attempts_sane/i,
    );
    await expect(message({ sendAttempts: -1 })).rejects.toThrow(/messages_send_attempts_sane/i);
  });

  it('keeps one status receipt per message and status, with the parent’s own instant', async () => {
    const own = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, own.numberId);
    const messageId = newId();
    const created = await h.unscoped.message.create({
      data: {
        id: messageId,
        organizationId: h.orgA.organizationId,
        conversationId: ours,
        direction: 'outbound',
        type: 'text',
        body: 'hello',
        status: 'sent',
      } as never,
    });
    const event = (over: Record<string, unknown> = {}) =>
      h.unscoped.messageStatusEvent.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          messageId,
          // Both halves of the parent's key: `messages` is partitioned by `created_at`.
          messageCreatedAt: created.createdAt,
          status: 'sent',
          occurredAt: new Date(),
          ...over,
        } as never,
      });
    await expect(event()).resolves.toBeTruthy();
    // The same fact twice would make the history read as two events.
    await expect(event()).rejects.toThrow(/message_status_event_once_key|unique/i);
    await expect(event({ status: 'delivered' })).resolves.toBeTruthy();
    // A failure that says nothing is a failure nobody can act on.
    await expect(event({ status: 'failed' })).rejects.toThrow(
      /message_status_events_failed_says_why/i,
    );
    await expect(event({ status: 'failed', errorCode: '131047' })).resolves.toBeTruthy();
    // The wrong instant is the wrong row: without the parent's `created_at` the FK cannot resolve.
    await expect(
      event({ status: 'read', messageCreatedAt: new Date(Date.now() - 86_400_000) }),
    ).rejects.toThrow(/message_status_events_message_same_org_fk|foreign key/i);
  });

  it('shows one workspace nothing of another’s templates or receipts', async () => {
    await template(h.orgA.organizationId);
    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      templates: await h.db.whatsAppTemplate.findMany({}),
      events: await h.db.messageStatusEvent.findMany({}),
    }));
    for (const [label, rows] of Object.entries(theirs)) {
      expect(
        rows.every((row) => row.organizationId === h.orgB.organizationId),
        label,
      ).toBe(true);
    }
  });

  // ── Phase 5 step 3 — attachments ─────────────────────────────────────────

  /** A message in whichever workspace is asked for, with both halves of its key. */
  async function messageIn(organizationId: string, over: Record<string, unknown> = {}) {
    const own = await number(organizationId);
    const conversationId = await conversation(organizationId, own.numberId);
    const created = await h.unscoped.message.create({
      data: {
        id: newId(),
        organizationId,
        conversationId,
        direction: 'inbound',
        type: 'image',
        status: 'delivered',
        ...over,
      } as never,
    });
    return { id: created.id, createdAt: created.createdAt, conversationId };
  }

  it('keeps one attachment per message, with the parent’s own instant', async () => {
    const parent = await messageIn(h.orgA.organizationId);
    const media = (over: Record<string, unknown> = {}) =>
      h.unscoped.messageMedia.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          messageId: parent.id,
          // Both halves, because `messages` is partitioned by `created_at` — the same reason the
          // status receipts carry it.
          messageCreatedAt: parent.createdAt,
          providerMediaId: `media_${newId().slice(-8)}`,
          mimeType: 'image/jpeg',
          ...over,
        } as never,
      });
    await expect(media()).resolves.toBeTruthy();
    // A message shows one attachment, so a replayed ingestion must not be able to write a second.
    await expect(media()).rejects.toThrow(/message_media_one_per_message|unique/i);

    const other = await messageIn(h.orgA.organizationId);
    // The wrong instant is the wrong row: without the parent's own `created_at` the FK cannot
    // resolve, however real the id is.
    await expect(
      media({ messageId: other.id, messageCreatedAt: new Date(Date.now() - 86_400_000) }),
    ).rejects.toThrow(/message_media_message_same_org_fk|foreign key/i);
  });

  it('refuses an attachment on another workspace’s message', async () => {
    const theirs = await messageIn(h.orgB.organizationId);
    await expect(
      h.unscoped.messageMedia.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          messageId: theirs.id,
          messageCreatedAt: theirs.createdAt,
          mimeType: 'image/jpeg',
        } as never,
      }),
    ).rejects.toThrow(/message_media_message_same_org_fk|foreign key/i);
  });

  it('insists a stored file has bytes and a refusal says why', async () => {
    const parent = await messageIn(h.orgA.organizationId);
    const media = (over: Record<string, unknown>) =>
      h.unscoped.messageMedia.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          messageId: parent.id,
          messageCreatedAt: parent.createdAt,
          mimeType: 'image/jpeg',
          ...over,
        } as never,
      });
    await expect(media({ downloadStatus: 'stored' })).rejects.toThrow(
      /message_media_stored_has_a_file/i,
    );
    await expect(media({ downloadStatus: 'refused' })).rejects.toThrow(
      /message_media_refused_says_why/i,
    );
    await expect(media({ downloadStatus: 'failed' })).rejects.toThrow(
      /message_media_refused_says_why/i,
    );
    await expect(
      media({ downloadStatus: 'stored', fileKey: 'org/a/whatsapp-media/x.jpg', sizeBytes: 1 }),
    ).resolves.toBeTruthy();
    // The honest state the mirror would have forbidden: an outbound attachment is stored by us
    // *before* Meta has it and before anything has been sent, so "not stored ⇒ no file key" is
    // false and deliberately not asserted.
    await expect(media({ sizeBytes: 0 })).rejects.toThrow(/message_media_size_sane/i);
    await expect(media({ attempts: -1 })).rejects.toThrow(/message_media_attempts_sane/i);
    await expect(media({ scanStatus: 'probably fine' })).rejects.toThrow(
      /message_media_scan_status/i,
    );
  });

  // ── Phase 5 step 4 — the shared inbox ────────────────────────────────────

  it('insists a lock has both halves, and a snooze says when', async () => {
    const own = await number(h.orgA.organizationId);
    const id = await conversation(h.orgA.organizationId, own.numberId);
    const set = (data: Record<string, unknown>) =>
      h.unscoped.conversation.update({ where: { id }, data: data as never });

    // A holder with no expiry is a lock that never lapses — the one failure the five-minute TTL
    // exists to prevent — and an expiry with no holder is an expiry for nobody. Both directions
    // are contradictions, which is why this one constraint is a biconditional.
    await expect(set({ lockUserId: h.orgA.userId })).rejects.toThrow(
      /conversations_lock_is_whole/i,
    );
    await expect(set({ lockExpiresAt: new Date() })).rejects.toThrow(
      /conversations_lock_is_whole/i,
    );
    await expect(
      set({ lockUserId: h.orgA.userId, lockExpiresAt: new Date() }),
    ).resolves.toBeTruthy();
    await expect(set({ lockUserId: null, lockExpiresAt: null })).resolves.toBeTruthy();

    await expect(set({ status: 'snoozed' })).rejects.toThrow(
      /conversations_snoozed_says_when/i,
    );
    await expect(
      set({ status: 'snoozed', snoozedUntil: new Date(Date.now() + 3_600_000) }),
    ).resolves.toBeTruthy();
    // The honest state the mirror would have forbidden: a conversation closed while it was snoozed
    // keeps the instant somebody asked for, which is the record of what they wanted.
    await expect(set({ status: 'closed', closedAt: new Date() })).resolves.toBeTruthy();
  });

  it('refuses a lock held by another workspace’s member', async () => {
    const own = await number(h.orgA.organizationId);
    const id = await conversation(h.orgA.organizationId, own.numberId);
    await expect(
      h.unscoped.conversation.update({
        where: { id },
        data: { lockUserId: h.orgB.userId, lockExpiresAt: new Date() } as never,
      }),
    ).rejects.toThrow(/conversations_locker_same_org_fk|foreign key/i);
  });

  it('refuses a note on another workspace’s conversation, or from another’s member', async () => {
    const own = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, own.numberId);
    const theirNumber = await number(h.orgB.organizationId);
    const theirs = await conversation(h.orgB.organizationId, theirNumber.numberId);
    const note = (over: Record<string, unknown> = {}) =>
      h.unscoped.conversationNote.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: ours,
          body: 'Asha wants possession by March',
          authorUserId: h.orgA.userId,
          ...over,
        } as never,
      });
    await expect(note()).resolves.toBeTruthy();
    await expect(note({ conversationId: theirs })).rejects.toThrow(
      /conversation_notes_conversation_same_org_fk|foreign key/i,
    );
    await expect(note({ authorUserId: h.orgB.userId })).rejects.toThrow(
      /conversation_notes_author_same_org_fk|foreign key/i,
    );
  });

  it('refuses a note with nothing in it, and one that names everybody', async () => {
    const own = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, own.numberId);
    const note = (over: Record<string, unknown>) =>
      h.unscoped.conversationNote.create({
        data: {
          id: newId(),
          organizationId: h.orgA.organizationId,
          conversationId: ours,
          body: 'something',
          authorUserId: h.orgA.userId,
          ...over,
        } as never,
      });
    await expect(note({ body: '   ' })).rejects.toThrow(/conversation_notes_body_not_blank/i);
    await expect(note({ body: 'a'.repeat(4001) })).rejects.toThrow(
      /conversation_notes_body_not_blank/i,
    );
    // `cardinality`, not `array_length`: on an empty array the latter is NULL and the check would
    // not bite at all, so this asserts the empty case is allowed *and* the ceiling holds.
    await expect(note({ mentionedUserIds: [] })).resolves.toBeTruthy();
    await expect(
      note({ mentionedUserIds: Array.from({ length: 21 }, () => newId()) }),
    ).rejects.toThrow(/conversation_notes_mentions_sane/i);
  });

  it('shows one workspace nothing of another’s notes', async () => {
    const own = await number(h.orgA.organizationId);
    const ours = await conversation(h.orgA.organizationId, own.numberId);
    await h.unscoped.conversationNote.create({
      data: {
        id: newId(),
        organizationId: h.orgA.organizationId,
        conversationId: ours,
        body: 'Private',
        authorUserId: h.orgA.userId,
      } as never,
    });
    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      notes: await h.db.conversationNote.findMany({}),
    }));
    expect(theirs.notes.every((row) => row.organizationId === h.orgB.organizationId)).toBe(true);
  });

  it('shows one workspace nothing of another’s attachments', async () => {
    const parent = await messageIn(h.orgA.organizationId);
    await h.unscoped.messageMedia.create({
      data: {
        id: newId(),
        organizationId: h.orgA.organizationId,
        messageId: parent.id,
        messageCreatedAt: parent.createdAt,
        mimeType: 'image/jpeg',
      } as never,
    });
    const theirs = await tenantContext.run(h.orgB.principal, async () => ({
      media: await h.db.messageMedia.findMany({}),
    }));
    expect(theirs.media.every((row) => row.organizationId === h.orgB.organizationId)).toBe(true);
  });
});
