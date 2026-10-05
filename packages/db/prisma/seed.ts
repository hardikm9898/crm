import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Algorithm, hash } from '@node-rs/argon2';
import { SYSTEM_ROLE_TEMPLATES, newId, newToken, normalizePhone } from '@leados/shared';
import { createUnscopedDbClient } from '../src/client.js';
import { seedPlatformCatalogue } from '../src/seeding/platform-catalogue.js';
import {
  seedCrmDefaults,
  seedDefaultAssignmentRule,
  seedDefaultTags,
  seedScoringAndViews,
} from '../src/seeding/crm-defaults.js';
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

/**
 * The password every seeded account shares, hashed once per run.
 *
 * Argon2id with the same algorithm the API uses — parameters are encoded in the hash, so a seeded
 * account verifies against `PasswordService` without the two having to agree on cost settings. The
 * plaintext is printed at the end of the run, because a seed whose credentials you have to read the
 * source to discover wastes everybody's afternoon.
 *
 * `SEED_PASSWORD` overrides it. This is development data by construction: `pnpm db:seed` is never
 * run against production, and the API refuses to boot in production with a development mailer
 * anyway.
 */
const SEED_PASSWORD = process.env['SEED_PASSWORD'] ?? 'LeadOsDevPassword2026';

async function hashSeedPassword(): Promise<string> {
  return hash(SEED_PASSWORD, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
}

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

/**
 * Runs the configuration seeders against an organization that already exists.
 *
 * Each one decides for itself whether there is anything to do, so this is safe to call on every
 * seed run. It deliberately does **not** create people or demo leads: those are sample data, and
 * duplicating them on every run would make the demo workspace grow without bound.
 */
async function topUpConfiguration(db: PrismaClient, organizationId: string): Promise<string[]> {
  const added: string[] = [];
  await db.$transaction(async (tx) => {
    if (await seedCrmDefaults(tx, organizationId)) added.push('CRM vocabulary');
    if ((await seedDefaultTags(tx, organizationId)) > 0) added.push('tags');

    const executives = await tx.userRole.findMany({
      where: { organizationId, role: { code: 'sales_executive' } },
      select: { userId: true },
    });
    const ruleId = await seedDefaultAssignmentRule(
      tx,
      organizationId,
      executives.map((row) => row.userId),
    );
    if (ruleId) added.push('assignment rule');

    const scoring = await seedScoringAndViews(tx, organizationId);
    if (scoring.bandIds.length > 0) added.push('score bands');
    if (scoring.ruleIds.length > 0) added.push('scoring rules');
    if (scoring.viewIds.length > 0) added.push('saved views');
  });
  return added;
}

async function seedOrganization(
  db: PrismaClient,
  spec: OrgSpec,
  planIds: Map<string, string>,
  passwordHash: string,
): Promise<void> {
  const existing = await db.organization.findUnique({ where: { slug: spec.slug } });
  if (existing) {
    // Not simply skipped. The people and the demo leads are created once, but the *configuration*
    // seeders are idempotent per concern, and skipping them meant a development workspace seeded
    // before a feature existed never received its defaults — which is how the score bands and saved
    // views came to be missing from every demo tenant after they were written. Re-running
    // `pnpm db:seed` is what a developer does after pulling a change that adds defaults, so it has
    // to top up rather than no-op.
    const added = await topUpConfiguration(db, existing.id);
    console.warn(
      added.length > 0
        ? `  organization ${spec.slug} already present — added ${added.join(', ')}`
        : `  organization ${spec.slug} already present and up to date`,
    );
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

    // Captured as people are created, so the demo leads below have real owners to be assigned to.
    const userIdsByRole = new Map<string, string[]>();
    for (const person of spec.people) {
      const user = await tx.user.upsert({
        where: { email: person.email },
        create: {
          id: newId(),
          email: person.email,
          name: person.name,
          passwordHash,
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

      userIdsByRole.set(person.roleCode, [...(userIdsByRole.get(person.roleCode) ?? []), user.id]);

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

    // The CRM vocabulary, from the same definition provisioning uses — two descriptions of
    // "what a new organization looks like" would drift, and the drift would first appear as a
    // support ticket from a real tenant.
    const crm = await seedCrmDefaults(tx, organizationId);
    // Outside the `if (crm)` below on purpose: `seedCrmDefaults` returns null when the vocabulary
    // already exists, so gating these on it meant an existing development workspace never received
    // anything added later — the bands, rules and views were simply missing from every org seeded
    // before they were written. Each of these is independently idempotent.
    await seedDefaultAssignmentRule(
      tx,
      organizationId,
      // The executives are the round-robin pool: a manager who also holds leads makes the demo
      // data less legible, and the fairness assertions less obvious.
      userIdsByRole.get('sales_executive') ?? [],
    );
    await seedScoringAndViews(tx, organizationId);
    if (crm) {
      await seedDemoLeads(tx, organizationId, crm, branchId, teamId, userIdsByRole);
    }

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

/**
 * A handful of leads per demo tenant, so every Phase 2 screen has something real to show and the
 * cross-tenant canary extends to the CRM: **both organizations get a lead on the same phone number**,
 * which is how a query that forgets its tenant filter shows up during ordinary development rather
 * than in the isolation suite alone.
 *
 * Each lead also gets a timeline entry and a touchpoint, because a lead with no history is not
 * something any Phase 2 screen can be judged against.
 */
interface DemoLeadSpec {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email?: string;
  readonly company?: string;
  readonly city: string;
  readonly source: string;
  readonly stageOffset: number;
  readonly assignTo: 'sales_executive' | 'sales_manager' | null;
  readonly valueMinor?: number;
}

const DEMO_LEADS: readonly DemoLeadSpec[] = [
  {
    firstName: 'Rohan',
    lastName: 'Desai',
    phone: SHARED_CUSTOMER_PHONE,
    email: 'rohan.desai@example.test',
    city: 'Pune',
    source: 'Website form',
    stageOffset: 0,
    assignTo: 'sales_executive',
    valueMinor: 450000000,
  },
  {
    firstName: 'Fatima',
    lastName: 'Sheikh',
    phone: '+919812345001',
    email: 'fatima.sheikh@example.test',
    company: 'Sheikh Textiles',
    city: 'Mumbai',
    source: 'Facebook Ads',
    stageOffset: 1,
    assignTo: 'sales_executive',
    valueMinor: 1200000000,
  },
  {
    firstName: 'Vikram',
    lastName: 'Rao',
    phone: '+919812345002',
    city: 'Bengaluru',
    source: 'Referral',
    stageOffset: 2,
    assignTo: 'sales_manager',
  },
  {
    firstName: 'Neha',
    lastName: 'Kulkarni',
    phone: '+919812345003',
    email: 'neha.k@example.test',
    city: 'Pune',
    source: 'WhatsApp',
    stageOffset: 1,
    // Deliberately unassigned: the "nobody is working this" case has to exist in demo data, or
    // the screen that surfaces it is never looked at.
    assignTo: null,
  },
  {
    firstName: 'Arjun',
    lastName: 'Menon',
    phone: '+919812345004',
    company: 'Menon & Co',
    city: 'Kochi',
    source: 'Walk-in',
    stageOffset: 3,
    assignTo: 'sales_manager',
    valueMinor: 780000000,
  },
];

async function seedDemoLeads(
  tx: PrismaClient,
  organizationId: string,
  crm: {
    defaultStatusId: string;
    pipelineId: string;
    sourceIdsByName: ReadonlyMap<string, string>;
  },
  branchId: string,
  teamId: string,
  userIdsByRole: ReadonlyMap<string, string[]>,
): Promise<void> {
  const stages = await tx.pipelineStage.findMany({
    where: { organizationId, pipelineId: crm.pipelineId },
    orderBy: { sortOrder: 'asc' },
  });
  if (stages.length === 0) return;

  const now = Date.now();
  for (const [index, spec] of DEMO_LEADS.entries()) {
    const leadId = newId();
    const stage = stages[Math.min(spec.stageOffset, stages.length - 1)];
    /* c8 ignore next */
    if (!stage) continue;
    const assignedUserId = spec.assignTo ? (userIdsByRole.get(spec.assignTo)?.[0] ?? null) : null;
    // Spread over the last fortnight so "created this week" and ageing reports have something
    // to distinguish.
    const createdAt = new Date(now - (index + 1) * 2 * 86_400_000);

    await tx.lead.create({
      data: {
        id: leadId,
        organizationId,
        firstName: spec.firstName,
        lastName: spec.lastName,
        fullName: `${spec.firstName} ${spec.lastName}`,
        company: spec.company ?? null,
        phoneE164: normalizePhone(spec.phone, 'IN').e164,
        phoneRaw: spec.phone,
        email: spec.email ?? null,
        city: spec.city,
        country: 'IN',
        leadSourceId: crm.sourceIdsByName.get(spec.source) ?? null,
        createdVia: 'manual',
        statusId: crm.defaultStatusId,
        pipelineId: crm.pipelineId,
        stageId: stage.id,
        priority: index === 0 ? 'high' : 'medium',
        valueMinor: spec.valueMinor ?? null,
        currency: spec.valueMinor ? 'INR' : null,
        assignedUserId,
        branchId,
        teamId: assignedUserId ? teamId : null,
        consentWhatsapp: true,
        consentCalls: true,
        createdAt,
        updatedAt: createdAt,
        lastActivityAt: createdAt,
        touchCount: 1,
      },
    });

    await tx.leadTouchpoint.create({
      data: {
        id: newId(),
        organizationId,
        leadId,
        sequence: 1,
        occurredAt: createdAt,
        channel: 'manual',
        leadSourceId: crm.sourceIdsByName.get(spec.source) ?? null,
      },
    });

    await tx.leadStatusHistory.create({
      data: {
        id: newId(),
        organizationId,
        leadId,
        toStatusId: crm.defaultStatusId,
        createdAt,
      },
    });

    await tx.activity.create({
      data: {
        id: newId(),
        organizationId,
        leadId,
        type: 'lead.created',
        actorType: 'system',
        actorLabel: 'seed',
        occurredAt: createdAt,
        payload: { fullName: `${spec.firstName} ${spec.lastName}`, createdVia: 'manual' },
      },
    });
  }
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required to seed');

  const db = createUnscopedDbClient({ connectionString });
  try {
    console.warn('seeding platform catalogue (permissions, features, plans)…');
    const planIds = await seedPlatformCatalogue(db);
    const passwordHash = await hashSeedPassword();

    await db.platformUser.upsert({
      where: { email: 'platform@leados.local' },
      create: {
        id: newId(),
        email: 'platform@leados.local',
        passwordHash,
        name: 'Platform Super Admin',
        isSuperAdmin: true,
      },
      update: {},
    });

    console.warn('seeding demo organizations…');
    for (const spec of ORGS) await seedOrganization(db, spec, planIds, passwordHash);

    // Sanity check: the canary phone must be identical in both tenants, so that any
    // query forgetting its organization filter returns two rows instead of one.
    console.warn(
      `shared canary phone across tenants: ${normalizePhone(SHARED_CUSTOMER_PHONE).e164}`,
    );
    console.warn(`every seeded account signs in with: ${SEED_PASSWORD}`);
    console.warn('seed complete.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error);
  process.exit(1);
});
