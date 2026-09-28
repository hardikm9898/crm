import { Injectable } from '@nestjs/common';
import {
  AppError,
  SYSTEM_ROLE_TEMPLATES,
  newId,
  newToken,
  withPlatformScope,
} from '@leados/shared';
import { seedCrmDefaults, seedDefaultAssignmentRule } from '@leados/db';
import { DbService } from '../../infra/db/db.service.js';
import { OutboxService } from '../../infra/outbox/outbox.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';

/**
 * Creates a usable organization: not just a row, but the roles, default branch and team,
 * owner membership, working hours and trial subscription that make the product work on
 * first login (FR-TEN-2, FR-IAM-5, FR-BIL-3).
 *
 * Everything happens in one transaction. A half-provisioned organization — a row with no
 * roles, or an owner with no membership — is unrecoverable without support intervention,
 * so it must not be possible to create one (Rule 18).
 *
 * Note what is *not* hardcoded here: the trial plan comes from a platform setting, the
 * roles come from shared templates, the trial length comes from the plan, and the CRM
 * vocabulary comes from `seedCrmDefaults` — every row of which the tenant can rename or
 * delete the moment they log in (Rules 4, 7).
 */
const DEFAULT_PLAN_SETTING_KEY = 'signup.default_plan_code';
const FALLBACK_TRIAL_DAYS = 7;
const WORKING_DAYS = [1, 2, 3, 4, 5, 6]; // Mon–Sat
const WORKDAY_START_MINUTE = 9 * 60 + 30;
const WORKDAY_END_MINUTE = 18 * 60 + 30;

export interface ProvisionInput {
  readonly organizationName: string;
  readonly ownerUserId: string;
  readonly industry?: string;
  readonly country?: string;
  readonly timezone?: string;
  readonly currency?: string;
}

export interface ProvisionResult {
  readonly organizationId: string;
  readonly slug: string;
  readonly branchId: string;
  readonly teamId: string;
  readonly ownerRoleId: string;
  readonly trialEndsAt: Date | null;
}

@Injectable()
export class OrganizationProvisioningService {
  constructor(
    private readonly db: DbService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const organizationId = newId();
    const branchId = newId();
    const teamId = newId();
    const now = new Date();

    const slug = await this.allocateSlug(input.organizationName);
    const plan = await this.resolveTrialPlan();

    const trialDays = plan?.trialDays ?? FALLBACK_TRIAL_DAYS;
    const trialEndsAt = new Date(now.getTime() + trialDays * 86_400_000);
    const periodEnd = new Date(now.getTime() + 30 * 86_400_000);

    const ownerRoleId = await withPlatformScope('signup: provision organization', async () =>
      this.db.client.$transaction(async (tx) => {
        await tx.organization.create({
          data: {
            id: organizationId,
            slug,
            name: input.organizationName.trim(),
            industry: input.industry ?? null,
            country: input.country ?? 'IN',
            timezone: input.timezone ?? 'Asia/Kolkata',
            defaultCurrency: input.currency ?? 'INR',
            defaultPhoneCountry: input.country ?? 'IN',
            status: 'trialing',
            publicKey: `pk_live_${newToken(18)}`,
            onboardingState: { completed: false, step: 'business_info' },
          },
        });

        await tx.branch.create({
          data: { id: branchId, organizationId, name: 'Head Office', code: 'HO', isDefault: true },
        });
        await tx.team.create({
          data: { id: teamId, organizationId, branchId, name: 'Sales Team' },
        });

        let resolvedOwnerRoleId: string | null = null;
        for (const template of SYSTEM_ROLE_TEMPLATES) {
          const roleId = newId();
          if (template.code === 'owner') resolvedOwnerRoleId = roleId;
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
        if (resolvedOwnerRoleId === null) {
          throw new Error('Role templates must include an "owner" role');
        }

        await tx.membership.create({
          data: {
            id: newId(),
            organizationId,
            userId: input.ownerUserId,
            status: 'active',
            defaultBranchId: branchId,
            isOwner: true,
            joinedAt: now,
          },
        });
        await tx.userRole.create({
          data: {
            id: newId(),
            organizationId,
            userId: input.ownerUserId,
            roleId: resolvedOwnerRoleId,
          },
        });
        await tx.workingHours.createMany({
          data: WORKING_DAYS.map((dayOfWeek) => ({
            id: newId(),
            organizationId,
            userId: input.ownerUserId,
            dayOfWeek,
            startMinute: WORKDAY_START_MINUTE,
            endMinute: WORKDAY_END_MINUTE,
          })),
        });

        // The CRM vocabulary, so a lead can be created on first login. Inside the same transaction
        // as everything else: an organization with no default status is one where lead creation
        // fails, which is exactly the half-provisioned state rule 18 forbids.
        await seedCrmDefaults(tx, organizationId);
        // The owner is the only member at signup, so they are the pool. A round-robin of one still
        // exercises the whole path — eligibility, working hours, the fallback — from day one.
        await seedDefaultAssignmentRule(tx, organizationId, [input.ownerUserId]);

        if (plan) {
          await tx.subscription.create({
            data: {
              id: newId(),
              organizationId,
              planId: plan.id,
              status: 'trialing',
              seats: 1,
              trialEndsAt,
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
            },
          });
        }

        await this.audit.recordInTransaction(tx, {
          organizationId,
          actorType: 'user',
          actorId: input.ownerUserId,
          action: 'organization.created',
          resourceType: 'organization',
          resourceId: organizationId,
          after: { slug, name: input.organizationName, plan: plan?.code ?? null },
        });

        await this.outbox.emit(
          tx,
          [
            {
              name: 'organization.created',
              aggregateType: 'organization',
              aggregateId: organizationId,
              payload: {
                organizationId,
                slug,
                name: input.organizationName,
                ownerUserId: input.ownerUserId,
                planCode: plan?.code ?? null,
                trialEndsAt: plan ? trialEndsAt.toISOString() : null,
              },
            },
          ],
          { organizationId },
        );

        return resolvedOwnerRoleId;
      }),
    );

    return {
      organizationId,
      slug,
      branchId,
      teamId,
      ownerRoleId,
      trialEndsAt: plan ? trialEndsAt : null,
    };
  }

  /**
   * Slugs are public (they appear in URLs), so they must be stable, readable and unique.
   * A collision appends a short random suffix rather than a counter, which would leak how
   * many organizations share a name.
   */
  private async allocateSlug(name: string): Promise<string> {
    const base = slugify(name);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate =
        attempt === 0
          ? base
          : `${base}-${newToken(3)
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')}`;
      const normalized = normalizeSlug(candidate);
      const taken = await withPlatformScope('signup: check slug', async () =>
        this.db.client.organization.findUnique({
          where: { slug: normalized },
          select: { id: true },
        }),
      );
      if (!taken) return normalized;
    }
    throw AppError.conflict(
      'Could not allocate a unique workspace address; please try another name',
    );
  }

  private async resolveTrialPlan(): Promise<{
    id: string;
    code: string;
    trialDays: number;
  } | null> {
    return withPlatformScope('signup: resolve default plan', async () => {
      const setting = await this.db.client.platformSetting.findUnique({
        where: { key: DEFAULT_PLAN_SETTING_KEY },
      });
      const code = typeof setting?.value === 'string' ? setting.value : null;

      const plan = code
        ? await this.db.client.plan.findUnique({ where: { code } })
        : await this.db.client.plan.findFirst({
            where: { isActive: true, isPublic: true },
            orderBy: { sortOrder: 'asc' },
          });

      // No plans configured is a legitimate state for a fresh deployment: the
      // organization is created without a subscription rather than signup failing.
      return plan ? { id: plan.id, code: plan.code, trialDays: plan.trialDays } : null;
    });
  }
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length >= 3 ? slug : `workspace-${slug}`;
}

/** Satisfies the organizations_slug_format_chk constraint in the database. */
function normalizeSlug(value: string): string {
  const cleaned = value.replace(/^-+|-+$/g, '');
  return cleaned.length >= 3
    ? cleaned
    : `workspace-${newToken(3)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')}`;
}
