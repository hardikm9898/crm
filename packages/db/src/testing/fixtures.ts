import { newId, newToken, systemPrincipal, type TenantPrincipal } from '@leados/shared';
import {
  createDbClient,
  createUnscopedDbClient,
  type DbClient,
  type UnscopedDbClient,
} from '../client.js';
import { withAuditPurge } from '../audit-purge.js';

/**
 * Test harness for the isolation suite. Builds two complete tenants so every test can
 * ask the only question that matters: can org A reach org B?
 */

export function testConnectionString(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL must be set to run integration tests');
  return url;
}

export interface TestTenant {
  organizationId: string;
  slug: string;
  branchId: string;
  teamId: string;
  roleId: string;
  userId: string;
  // Phase 2 — so the isolation suite can prove the CRM's own composite foreign keys.
  statusId: string;
  pipelineId: string;
  stageId: string;
  leadId: string;
  principal: TenantPrincipal;
}

export interface TestHarness {
  db: DbClient;
  unscoped: UnscopedDbClient;
  orgA: TestTenant;
  orgB: TestTenant;
  dispose: () => Promise<void>;
}

export async function createHarness(): Promise<TestHarness> {
  const connectionString = testConnectionString();
  const unscoped = createUnscopedDbClient({ connectionString, poolMax: 5 });
  const db = createDbClient({ connectionString, poolMax: 5 });

  const orgA = await createTenant(unscoped, 'a');
  const orgB = await createTenant(unscoped, 'b');

  return {
    db,
    unscoped,
    orgA,
    orgB,
    dispose: async () => {
      const organizationIds = [orgA.organizationId, orgB.organizationId];
      // Audit rows are append-only and RESTRICT organization deletion, so test cleanup
      // goes through the same sanctioned purge path the retention job uses.
      await withAuditPurge(unscoped, 'integration test cleanup', async (tx) => {
        await tx.auditLog.deleteMany({ where: { organizationId: { in: organizationIds } } });
      });
      await unscoped.organization.deleteMany({ where: { id: { in: organizationIds } } });
      await unscoped.user.deleteMany({ where: { id: { in: [orgA.userId, orgB.userId] } } });
      await unscoped.$disconnect();
      await db.$disconnect();
    },
  };
}

async function createTenant(db: UnscopedDbClient, label: string): Promise<TestTenant> {
  const organizationId = newId();
  const slug = `test-${label}-${newToken(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;
  const branchId = newId();
  const teamId = newId();
  const roleId = newId();
  const userId = newId();
  const now = new Date();

  await db.organization.create({
    data: {
      id: organizationId,
      slug,
      name: `Test Org ${label.toUpperCase()}`,
      publicKey: `pk_test_${newToken(10)}`,
      status: 'active',
    },
  });
  await db.branch.create({
    data: { id: branchId, organizationId, name: 'Main', code: 'MAIN', isDefault: true },
  });
  await db.team.create({ data: { id: teamId, organizationId, branchId, name: 'Team' } });
  await db.role.create({
    data: { id: roleId, organizationId, code: 'tester', name: 'Tester', isSystem: false },
  });
  await db.user.create({
    data: { id: userId, email: `${slug}@test.local`, name: `User ${label}`, status: 'active' },
  });
  await db.membership.create({
    data: {
      id: newId(),
      organizationId,
      userId,
      status: 'active',
      defaultBranchId: branchId,
      joinedAt: now,
    },
  });
  await db.userRole.create({ data: { id: newId(), organizationId, userId, roleId } });

  // The minimum CRM vocabulary a lead needs. Written directly rather than through
  // `seedCrmDefaults` so the fixture stays small and its ids are predictable to the tests.
  const statusId = newId();
  const pipelineId = newId();
  const stageId = newId();
  const leadId = newId();
  await db.leadStatus.create({
    data: { id: statusId, organizationId, name: 'New', category: 'open', isDefault: true },
  });
  await db.pipeline.create({
    data: { id: pipelineId, organizationId, name: 'Sales', entityType: 'lead', isDefault: true },
  });
  await db.pipelineStage.create({
    data: { id: stageId, organizationId, pipelineId, name: 'Enquiry', sortOrder: 0 },
  });
  await db.lead.create({
    data: {
      id: leadId,
      organizationId,
      fullName: `Lead ${label}`,
      statusId,
      pipelineId,
      stageId,
    },
  });

  return {
    organizationId,
    slug,
    branchId,
    teamId,
    roleId,
    userId,
    statusId,
    pipelineId,
    stageId,
    leadId,
    principal: {
      ...systemPrincipal(organizationId, `test-${label}`),
      actorType: 'user',
      actorId: userId,
    },
  };
}
