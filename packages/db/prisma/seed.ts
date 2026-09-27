import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  PERMISSION_CATALOGUE,
  SYSTEM_ROLE_TEMPLATES,
  newId,
  newToken,
  normalizePhone,
} from '@leados/shared';
import { createUnscopedDbClient } from '../src/client.js';
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

const PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    priceMinor: 199_900n,
    trialDays: 7,
    sortOrder: 1,
    limits: {
      users: 3n,
      leads: 2_000n,
      whatsapp_numbers: 1n,
      whatsapp_messages_monthly: 1_000n,
      workflows: 3n,
      automation_actions_daily: 500n,
      websites: 1n,
      storage_bytes: 2_147_483_648n,
      api_calls_monthly: 10_000n,
      analytics_retention_days: 90n,
    },
    flags: {
      whatsapp: true,
      automation: true,
      website: false,
      analytics: true,
      marketing: false,
      ai: false,
    },
  },
  {
    code: 'growth',
    name: 'Growth',
    priceMinor: 599_900n,
    trialDays: 7,
    sortOrder: 2,
    limits: {
      users: 15n,
      leads: 25_000n,
      whatsapp_numbers: 3n,
      whatsapp_messages_monthly: 20_000n,
      workflows: 20n,
      automation_actions_daily: 5_000n,
      websites: 3n,
      storage_bytes: 21_474_836_480n,
      api_calls_monthly: 200_000n,
      analytics_retention_days: 180n,
    },
    flags: {
      whatsapp: true,
      automation: true,
      website: true,
      analytics: true,
      marketing: true,
      ai: false,
    },
  },
  {
    code: 'scale',
    name: 'Scale',
    priceMinor: 1_499_900n,
    trialDays: 14,
    sortOrder: 3,
    limits: {
      users: null,
      leads: null,
      whatsapp_numbers: 10n,
      whatsapp_messages_monthly: 200_000n,
      workflows: null,
      automation_actions_daily: 50_000n,
      websites: 10n,
      storage_bytes: 107_374_182_400n,
      api_calls_monthly: 2_000_000n,
      analytics_retention_days: 365n,
    },
    flags: {
      whatsapp: true,
      automation: true,
      website: true,
      analytics: true,
      marketing: true,
      ai: true,
    },
  },
] as const;

const FEATURES = [
  { key: 'users', name: 'Team members', unit: 'count' as const },
  { key: 'leads', name: 'Leads stored', unit: 'count' as const },
  { key: 'whatsapp_numbers', name: 'WhatsApp numbers', unit: 'count' as const },
  {
    key: 'whatsapp_messages_monthly',
    name: 'WhatsApp messages per month',
    unit: 'per_month' as const,
  },
  { key: 'workflows', name: 'Active workflows', unit: 'count' as const },
  {
    key: 'automation_actions_daily',
    name: 'Automation actions per day',
    unit: 'per_month' as const,
  },
  { key: 'websites', name: 'Websites', unit: 'count' as const },
  { key: 'storage_bytes', name: 'File storage', unit: 'bytes' as const },
  { key: 'api_calls_monthly', name: 'API calls per month', unit: 'per_month' as const },
  { key: 'analytics_retention_days', name: 'Analytics retention (days)', unit: 'count' as const },
  { key: 'whatsapp', name: 'WhatsApp module', unit: 'bool' as const },
  { key: 'automation', name: 'Automation module', unit: 'bool' as const },
  { key: 'website', name: 'Website builder', unit: 'bool' as const },
  { key: 'analytics', name: 'Website analytics', unit: 'bool' as const },
  { key: 'marketing', name: 'Marketing & attribution', unit: 'bool' as const },
  { key: 'ai', name: 'AI assistance', unit: 'bool' as const },
];

/**
 * Dev-only password hash placeholder. Real Argon2id hashing arrives with the auth
 * module in Phase 1 step 2; until then no login path exists, so seeding a usable
 * credential would be security theatre. Password: see docs/README once auth lands.
 */
const DEV_PASSWORD_PLACEHOLDER = 'PENDING_ARGON2ID_HASH__NO_LOGIN_UNTIL_AUTH_MODULE';

async function seedPlatform(db: PrismaClient): Promise<Map<string, string>> {
  for (const permission of PERMISSION_CATALOGUE) {
    await db.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        module: permission.module,
        description: permission.description,
        supportsScope: permission.supportsScope,
      },
      update: { module: permission.module, description: permission.description },
    });
  }

  for (const feature of FEATURES) {
    await db.feature.upsert({
      where: { key: feature.key },
      create: { key: feature.key, name: feature.name, unit: feature.unit },
      update: { name: feature.name, unit: feature.unit },
    });
  }

  const planIds = new Map<string, string>();
  for (const plan of PLANS) {
    const existing = await db.plan.findUnique({ where: { code: plan.code } });
    const id = existing?.id ?? newId();
    await db.plan.upsert({
      where: { code: plan.code },
      create: {
        id,
        code: plan.code,
        name: plan.name,
        interval: 'month',
        priceMinor: plan.priceMinor,
        currency: 'INR',
        trialDays: plan.trialDays,
        sortOrder: plan.sortOrder,
      },
      update: { name: plan.name, priceMinor: plan.priceMinor, trialDays: plan.trialDays },
    });
    planIds.set(plan.code, id);

    const entries: { featureKey: string; limitValue: bigint | null; isEnabled: boolean }[] = [
      ...Object.entries(plan.limits).map(([featureKey, limitValue]) => ({
        featureKey,
        limitValue: limitValue as bigint | null,
        isEnabled: true,
      })),
      ...Object.entries(plan.flags).map(([featureKey, isEnabled]) => ({
        featureKey,
        limitValue: null,
        isEnabled,
      })),
    ];
    for (const entry of entries) {
      await db.planFeature.upsert({
        where: { planId_featureKey: { planId: id, featureKey: entry.featureKey } },
        create: { planId: id, ...entry },
        update: { limitValue: entry.limitValue, isEnabled: entry.isEnabled },
      });
    }
  }

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

  return planIds;
}

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
    const planIds = await seedPlatform(db);

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
