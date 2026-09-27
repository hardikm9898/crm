import { Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext } from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import type { TransactionClient } from '../../infra/outbox/outbox.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService } from '../../infra/outbox/outbox.service.js';
import { PrincipalService } from '../auth/application/principal.service.js';
import type {
  CreateBranchInput,
  CreateTeamInput,
  TeamMemberInput,
  UpdateBranchInput,
  UpdateOnboardingInput,
  UpdateOrganizationInput,
  UpdateTeamInput,
} from './organizations.dto.js';

/**
 * The organization's own settings, branches and teams.
 *
 * Branch and team membership feed `DataScopeService`, so changes here alter what people can see —
 * which is why every one of them invalidates the cached grants. Forgetting that would leave a
 * moved user seeing their old branch for five minutes.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly principals: PrincipalService,
  ) {}

  // ── Organization ──────────────────────────────────────────────────────────

  async get() {
    const organizationId = tenantContext.organizationId('organization.get');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    const [branches, teams, members, subscription] = await Promise.all([
      this.db.client.branch.count({ where: { deletedAt: null } }),
      this.db.client.team.count({ where: { deletedAt: null } }),
      this.db.client.membership.count({ where: { deletedAt: null, status: 'active' } }),
      this.db.client.subscription.findUnique({
        where: { organizationId },
        include: { plan: { select: { code: true, name: true } } },
      }),
    ]);

    return {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      legalName: organization.legalName,
      industry: organization.industry,
      country: organization.country,
      timezone: organization.timezone,
      defaultCurrency: organization.defaultCurrency,
      defaultPhoneCountry: organization.defaultPhoneCountry,
      logoUrl: organization.logoUrl,
      status: organization.status,
      // The public key identifies the tenant to the ingestion API; it is not a secret, but it is
      // only shown to someone who may read the organization's settings.
      publicKey: organization.publicKey,
      onboarding: organization.onboardingState,
      counts: { branches, teams, activeMembers: members },
      subscription: subscription
        ? {
            status: subscription.status,
            planCode: subscription.plan.code,
            planName: subscription.plan.name,
            trialEndsAt: subscription.trialEndsAt,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
      createdAt: organization.createdAt,
    };
  }

  async update(input: UpdateOrganizationInput) {
    const organizationId = tenantContext.organizationId('organization.update');
    const before = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });

    const updated = await this.db.client.$transaction(async (tx) => {
      const organization = await tx.organization.update({
        where: { id: organizationId },
        data: input,
      });
      await this.audit.recordInTransaction(tx, {
        action: 'organization.updated',
        resourceType: 'organization',
        resourceId: organizationId,
        before: changedFields(before, input),
        after: input as Record<string, unknown>,
      });
      return organization;
    });

    return { id: updated.id, name: updated.name, timezone: updated.timezone };
  }

  // ── Onboarding ────────────────────────────────────────────────────────────

  /**
   * Onboarding state is a JSON document rather than columns: the wizard's steps change with the
   * product, and a migration per step would be friction for no benefit (`FR-ONB-1`).
   */
  async updateOnboarding(input: UpdateOnboardingInput) {
    const organizationId = tenantContext.organizationId('organization.onboarding');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });

    const current = (organization.onboardingState ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...current,
      ...(input.step === undefined ? {} : { step: input.step }),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
      ...(input.data === undefined
        ? {}
        : { data: { ...((current['data'] as Record<string, unknown>) ?? {}), ...input.data } }),
    };
    if (input.completed === true) next['completedAt'] = new Date().toISOString();

    await this.db.client.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: organizationId },
        data: { onboardingState: next as never },
      });
      if (input.completed === true && current['completed'] !== true) {
        await this.outbox.emit(tx, [
          {
            name: 'onboarding.completed',
            aggregateType: 'organization',
            aggregateId: organizationId,
            payload: { organizationId },
          },
        ]);
      }
    });

    return next;
  }

  // ── Branches ──────────────────────────────────────────────────────────────

  async listBranches() {
    const branches = await this.db.client.branch.findMany({
      where: { deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const counts = await this.db.client.membership.groupBy({
      by: ['defaultBranchId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const byBranch = new Map(counts.map((row) => [row.defaultBranchId, row._count._all]));

    const items = branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      code: branch.code,
      city: branch.city,
      state: branch.state,
      country: branch.country,
      timezone: branch.timezone,
      isDefault: branch.isDefault,
      memberCount: byBranch.get(branch.id) ?? 0,
    }));
    // Branches are a small bounded set, but the shape stays the same as every other collection:
    // one envelope for clients to read (docs/api-architecture.md §2).
    return { items, pagination: fullPage(items.length) };
  }

  async createBranch(input: CreateBranchInput) {
    const branchId = newId();
    await this.db.client.$transaction(async (tx) => {
      if (input.isDefault === true) await this.clearDefaultBranch(tx);
      await tx.branch.create({ data: { id: branchId, ...input } as never });
      await this.audit.recordInTransaction(tx, {
        action: 'branch.created',
        resourceType: 'branch',
        resourceId: branchId,
        after: { name: input.name, code: input.code ?? null },
      });
    });
    return { id: branchId, name: input.name };
  }

  async updateBranch(branchId: string, input: UpdateBranchInput) {
    // Tenant-scoped read: a branch id from another organization simply is not found.
    const branch = await this.db.client.branch.findFirst({
      where: { id: branchId, deletedAt: null },
    });
    if (!branch) throw AppError.notFound('Branch');

    await this.db.client.$transaction(async (tx) => {
      if (input.isDefault === true) await this.clearDefaultBranch(tx);
      await tx.branch.update({ where: { id: branchId }, data: input as never });
      await this.audit.recordInTransaction(tx, {
        action: 'branch.updated',
        resourceType: 'branch',
        resourceId: branchId,
        before: changedFields(branch, input),
        after: input as Record<string, unknown>,
      });
    });
    return { id: branchId };
  }

  async deleteBranch(branchId: string) {
    const branch = await this.db.client.branch.findFirst({
      where: { id: branchId, deletedAt: null },
    });
    if (!branch) throw AppError.notFound('Branch');
    if (branch.isDefault) {
      throw AppError.businessRule(
        'The default branch cannot be deleted. Make another branch default first.',
      );
    }

    // Referential reality: people and teams point at this branch, and the composite foreign keys
    // RESTRICT rather than cascade. Reporting what is in the way beats a foreign-key error.
    const [members, teams] = await Promise.all([
      this.db.client.membership.count({ where: { defaultBranchId: branchId, deletedAt: null } }),
      this.db.client.team.count({ where: { branchId, deletedAt: null } }),
    ]);
    if (members > 0 || teams > 0) {
      throw AppError.businessRule('Move the people and teams in this branch before deleting it', {
        members,
        teams,
      });
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.branch.update({ where: { id: branchId }, data: { deletedAt: new Date() } });
      await this.audit.recordInTransaction(tx, {
        action: 'branch.deleted',
        resourceType: 'branch',
        resourceId: branchId,
        before: { name: branch.name },
      });
    });
    await this.invalidateGrants();
    return { deleted: true };
  }

  // ── Teams ─────────────────────────────────────────────────────────────────

  async listTeams() {
    const teams = await this.db.client.team.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { members: { select: { userId: true, isLead: true } } },
    });
    const items = teams.map((team) => ({
      id: team.id,
      name: team.name,
      description: team.description,
      branchId: team.branchId,
      memberCount: team.members.length,
      leadUserIds: team.members.filter((member) => member.isLead).map((member) => member.userId),
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createTeam(input: CreateTeamInput) {
    if (input.branchId) await this.assertBranchExists(input.branchId);
    const teamId = newId();
    await this.db.client.$transaction(async (tx) => {
      await tx.team.create({ data: { id: teamId, ...input } as never });
      await this.audit.recordInTransaction(tx, {
        action: 'team.created',
        resourceType: 'team',
        resourceId: teamId,
        after: { name: input.name },
      });
    });
    return { id: teamId, name: input.name };
  }

  async updateTeam(teamId: string, input: UpdateTeamInput) {
    const team = await this.db.client.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw AppError.notFound('Team');
    if (input.branchId) await this.assertBranchExists(input.branchId);

    await this.db.client.$transaction(async (tx) => {
      await tx.team.update({ where: { id: teamId }, data: input as never });
      await this.audit.recordInTransaction(tx, {
        action: 'team.updated',
        resourceType: 'team',
        resourceId: teamId,
        before: changedFields(team, input),
        after: input as Record<string, unknown>,
      });
    });
    return { id: teamId };
  }

  async deleteTeam(teamId: string) {
    const team = await this.db.client.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw AppError.notFound('Team');

    await this.db.client.$transaction(async (tx) => {
      await tx.teamMember.deleteMany({ where: { teamId } });
      await tx.team.update({ where: { id: teamId }, data: { deletedAt: new Date() } });
      await this.audit.recordInTransaction(tx, {
        action: 'team.deleted',
        resourceType: 'team',
        resourceId: teamId,
        before: { name: team.name },
      });
    });
    // Team membership decides what a team-scoped user can see, so the cached grants must go.
    await this.invalidateGrants();
    return { deleted: true };
  }

  async addTeamMember(teamId: string, input: TeamMemberInput) {
    const team = await this.db.client.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw AppError.notFound('Team');
    await this.assertMemberExists(input.userId);

    const existing = await this.db.client.teamMember.findFirst({
      where: { teamId, userId: input.userId },
    });
    if (existing) {
      await this.db.client.teamMember.update({
        where: { id: existing.id },
        data: { isLead: input.isLead ?? existing.isLead },
      });
    } else {
      await this.db.client.teamMember.create({
        data: { id: newId(), teamId, userId: input.userId, isLead: input.isLead ?? false } as never,
      });
    }

    await this.audit.record({
      action: 'team.member_added',
      resourceType: 'team',
      resourceId: teamId,
      after: { userId: input.userId, isLead: input.isLead ?? false },
    });
    await this.invalidateGrants();
    return { teamId, userId: input.userId };
  }

  async removeTeamMember(teamId: string, userId: string) {
    const removed = await this.db.client.teamMember.deleteMany({ where: { teamId, userId } });
    if (removed.count === 0) throw AppError.notFound('Team member');

    await this.audit.record({
      action: 'team.member_removed',
      resourceType: 'team',
      resourceId: teamId,
      before: { userId },
    });
    await this.invalidateGrants();
    return { removed: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.db.client.branch.findFirst({
      where: { id: branchId, deletedAt: null },
    });
    if (!branch) throw AppError.notFound('Branch');
  }

  private async assertMemberExists(userId: string): Promise<void> {
    const membership = await this.db.client.membership.findFirst({
      where: { userId, deletedAt: null },
    });
    if (!membership) throw AppError.notFound('Member');
  }

  /** Only one branch may be default, so setting one clears the rest. */
  private async clearDefaultBranch(tx: TransactionClient): Promise<void> {
    await tx.branch.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  private async invalidateGrants(): Promise<void> {
    await this.principals.invalidateOrganization(
      tenantContext.organizationId('organizations.invalidate'),
    );
  }
}

/** The previous values of just the fields being changed — enough for an audit diff, no more. */
function changedFields(
  before: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key in before) result[key] = before[key];
  }
  return result;
}

/** Pagination block for a bounded collection returned in full. */
export function fullPage(total: number): {
  limit: number;
  nextCursor: null;
  hasMore: false;
  total: number;
} {
  return { limit: total, nextCursor: null, hasMore: false, total };
}
