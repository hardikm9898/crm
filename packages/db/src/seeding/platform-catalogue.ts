import { PERMISSION_CATALOGUE, newId } from '@leados/shared';
import { seedIndustryTemplates } from './industry-templates.js';
import type { UnscopedDbClient } from '../client.js';

/**
 * Seeds the platform catalogue: the permission registry, the entitlement feature list, the
 * plans and the signup defaults.
 *
 * This is not demo data — it is reference data the product cannot function without. A
 * database with migrations applied but no catalogue cannot create an organization at all,
 * because `role_permissions` references `permissions`. It therefore lives here rather than
 * in the development seed script, and is used by both that script and the test harness
 * (Rule 3: one implementation, two consumers).
 *
 * Idempotent: safe to run on every boot of a test suite and on every deploy.
 */

export interface PlanSeed {
  readonly code: string;
  readonly name: string;
  readonly priceMinor: bigint;
  readonly trialDays: number;
  readonly sortOrder: number;
  readonly limits: Readonly<Record<string, bigint | null>>;
  readonly flags: Readonly<Record<string, boolean>>;
}

export const FEATURE_SEEDS = [
  { key: 'users', name: 'Team members', unit: 'count' },
  { key: 'leads', name: 'Leads stored', unit: 'count' },
  { key: 'whatsapp_numbers', name: 'WhatsApp numbers', unit: 'count' },
  { key: 'whatsapp_messages_monthly', name: 'WhatsApp messages per month', unit: 'per_month' },
  { key: 'workflows', name: 'Active workflows', unit: 'count' },
  { key: 'automation_actions_daily', name: 'Automation actions per day', unit: 'per_month' },
  { key: 'websites', name: 'Websites', unit: 'count' },
  { key: 'storage_bytes', name: 'File storage', unit: 'bytes' },
  { key: 'api_calls_monthly', name: 'API calls per month', unit: 'per_month' },
  { key: 'analytics_retention_days', name: 'Analytics retention (days)', unit: 'count' },
  { key: 'whatsapp', name: 'WhatsApp module', unit: 'bool' },
  { key: 'automation', name: 'Automation module', unit: 'bool' },
  { key: 'website', name: 'Website builder', unit: 'bool' },
  { key: 'analytics', name: 'Website analytics', unit: 'bool' },
  { key: 'marketing', name: 'Marketing & attribution', unit: 'bool' },
  { key: 'ai', name: 'AI assistance', unit: 'bool' },
] as const;

/** Starting prices in INR paise. Editable by Super Admin — never read from code (Rule 7). */
export const PLAN_SEEDS: readonly PlanSeed[] = [
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
];

export const DEFAULT_PLAN_SETTING_KEY = 'signup.default_plan_code';

export async function seedPlatformCatalogue(db: UnscopedDbClient): Promise<Map<string, string>> {
  // The industry templates are catalogue data too (`FR-ONB-2`), and for the same reason: a
  // workspace cannot apply a template that is not in the table, and the table must not be a second
  // definition of one that already lives in `@leados/shared`.
  await seedIndustryTemplates(db);

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

  for (const feature of FEATURE_SEEDS) {
    await db.feature.upsert({
      where: { key: feature.key },
      create: { key: feature.key, name: feature.name, unit: feature.unit },
      update: { name: feature.name, unit: feature.unit },
    });
  }

  const planIds = new Map<string, string>();
  for (const plan of PLAN_SEEDS) {
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

    const entries = [
      ...Object.entries(plan.limits).map(([featureKey, limitValue]) => ({
        featureKey,
        limitValue,
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

  await db.platformSetting.upsert({
    where: { key: DEFAULT_PLAN_SETTING_KEY },
    create: { key: DEFAULT_PLAN_SETTING_KEY, value: 'starter' },
    update: {},
  });

  return planIds;
}
