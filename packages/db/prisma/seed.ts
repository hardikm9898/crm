import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { SYSTEM_ROLE_TEMPLATES, newId, newToken, normalizePhone } from '@leados/shared';
import { createUnscopedDbClient } from '../src/client.js';
import { seedPlatformCatalogue } from '../src/seeding/platform-catalogue.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Development seed.
 *
 * Deliberately creates TWO organizations that share a customer phone number and an
 * overlapping user email pattern. Cross-tenant bugs and duplicate-detection behaviour
 * then show up during ordinary development, not only in the CI isolation suite
 * (docs/deployment-architecture.md §2).
 *
 * Idempotent: safe to re-run.
 */

interface OrgSpec {
  slug: string;
  name: string;
  industry: string;
  planCode: string;
  people: { email: string; name: string; roleCode: string; isOwner?: boolean }[];
}

/** The same customer phone, present in both tenants — the cross-tenant canary. */
const SHARED_CUSTOMER_PHONE = '+919876543210';

const ORGS: OrgSpec[] = [
  {
    slug: 'acme-realty',
    name: 'Acme Realty',
    industry: 'real_estate',
    planCode: 'growth',
    people: [
      { email: 'owner@acme-realty.test', name: 'Anita Sharma', roleCode: 'owner', isOwner: true },
      { email: 'manager@acme-realty.test', name: 'Rahul Verma', roleCode: 'sales_manager' },
      { email: 'exec@acme-realty.test', name: 'Priya Nair', roleCode: 'sales_executive' },
      { email: 'exec2@acme-realty.test', name: 'Imran Qureshi', roleCode: 'sales_executive' },
    ],
  },
  {
    slug: 'brightpath-academy',
    name: 'BrightPath Academy',
    industry: 'education',
    planCode: 'starter',
    people: [
      { email: 'owner@brightpath.test', name: 'Suresh Iyer', roleCode: 'owner', isOwner: true },
      { email: 'exec@brightpath.test', name: 'Meera Joshi', roleCode: 'sales_executive' },
    ],
  },
];

async function seedOrganization(
  db: PrismaClient,
  spec: OrgSpec,
  planIds: Map<string, string>,
): Promise<void> {
  const existing = await db.organization.findUnique({ where: { slug: spec.slug } });
  if (existing) {
    console.warn(`  organization ${spec.slug} already present — skipping`);
    return;
  }

  const organizationId = newId();
  const now = new Date();
  const planId = planIds.get(spec.planCode);
  if (!planId) throw new Error(`Unknown plan code in seed: ${spec.planCode}`);

  await db.$transaction(async (tx) => {
    await tx.organization.create({
      data: {
        id: organizationId,
        slug: spec.slug,
        name: spec.name,
        industry: spec.industry,
        publicKey: `pk_dev_${newToken(12)}`,
        status: 'trialing',
        settings: { seededAt: now.toISOString(), sharedCanaryPhone: SHARED_CUSTOMER_PHONE },
        onboardingState: { completed: false, step: 'business_info' },
      },
    });

    const branchId = newId();
    await tx.branch.create({
      data: {
        id: branchId,
        organizationId,
        name: 'Head Office',
        code: 'HO',
        city: spec.slug === 'acme-realty' ? 'Ahmedabad' : 'Pune',
        country: 'IN',
        isDefault: true,
      },
    });

    const teamId = newId();
    await tx.team.create({
      data: { id: teamId, organizationId, branchId, name: 'Sales Team A' },
    });

    // Roles from the shared templates: seeded, editable, never referenced by name in code.
    const roleIds = new Map<string, string>();
    for (const template of SYSTEM_ROLE_TEMPLATES) {
      const roleId = newId();
      roleIds.set(template.code, roleId);
      await tx.role.create({
        data: {
          id: roleId,
          organizationId,
          code: template.code,
          name: template.name,
          description: template.description,
          isSystem: true,
        },
      });
      await tx.rolePermission.createMany({
        data: template.grants.map((grant) => ({
          id: newId(),
          organizationId,
          roleId,
          permissionKey: grant.permission,
          scope: grant.scope,
        })),
      });
    }

    for (const person of spec.people) {
      const user = await tx.user.upsert({
        where: { email: person.email },
        create: {
          id: newId(),
          email: person.email,
          name: person.name,
          passwordHash: DEV_PASSWORD_PLACEHOLDER,
          status: 'active',
          timezone: 'Asia/Kolkata',
          emailVerifiedAt: now,
        },
        update: {},
      });

      await tx.membership.create({
        data: {
          id: newId(),
          organizationId,
          userId: user.id,
          status: 'active',
          defaultBranchId: branchId,
          isOwner: person.isOwner ?? false,
          joinedAt: now,
        },
      });

      const roleId = roleIds.get(person.roleCode);
      if (!roleId) throw new Error(`Unknown role code in seed: ${person.roleCode}`);
      await tx.userRole.create({ data: { id: newId(), organizationId, userId: user.id, roleId } });

      if (person.roleCode !== 'owner') {
        await tx.teamMember.create({
          data: {
            id: newId(),
            organizationId,
            teamId,
            userId: user.id,
            isLead: person.roleCode === 'sales_manager',
          },
        });
      }

      // Mon–Sat, 09:30–18:30 — consumed by assignment, SLA clocks and automation delays.
      await tx.workingHours.createMany({
        data: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
          id: newId(),
          organizationId,
          userId: user.id,
          dayOfWeek,
          startMinute: 9 * 60 + 30,
          endMinute: 18 * 60 + 30,
        })),
      });
    }

    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    await tx.subscription.create({
      data: {
        id: newId(),
        organizationId,
        planId,
        status: 'trialing',
        seats: spec.people.length,
        trialEndsAt: trialEnd,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    });

    await tx.auditLog.create({
      data: {
        id: newId(),
        organizationId,
        actorType: 'system',
        actorLabel: 'seed',
        action: 'organization.seeded',
        resourceType: 'organization',
        resourceId: organizationId,
        after: { slug: spec.slug, plan: spec.planCode },
      },
    });
  });

  console.warn(`  seeded ${spec.slug} (${spec.people.length} people, plan ${spec.planCode})`);
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required to seed');

  const db = createUnscopedDbClient({ connectionString });
  try {
    console.warn('seeding platform catalogue (permissions, features, plans)…');
    const planIds = await seedPlatformCatalogue(db);

    await db.platformUser.upsert({
      where: { email: 'platform@leados.local' },
      create: {
        id: newId(),
        email: 'platform@leados.local',
        passwordHash: DEV_PASSWORD_PLACEHOLDER,
        name: 'Platform Super Admin',
        isSuperAdmin: true,
      },
      update: {},
    });

    console.warn('seeding demo organizations…');
    for (const spec of ORGS) await seedOrganization(db, spec, planIds);

    // Sanity check: the canary phone must be identical in both tenants, so that any
    // query forgetting its organization filter returns two rows instead of one.
    console.warn(
      `shared canary phone across tenants: ${normalizePhone(SHARED_CUSTOMER_PHONE).e164}`,
    );
    console.warn('seed complete.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error);
  process.exit(1);
});
