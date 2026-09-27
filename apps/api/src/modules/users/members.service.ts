import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  PERMISSIONS,
  newId,
  newToken,
  tenantContext,
  withPlatformScope,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { OutboxService } from '../../infra/outbox/outbox.service.js';
import { EntitlementService } from '../../infra/entitlements/entitlement.service.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { MAILER, type MailerPort } from '../../infra/mail/mailer.port.js';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { PrincipalService } from '../auth/application/principal.service.js';
import { TokenService } from '../auth/application/token.service.js';
import type { InviteMemberInput, ListMembersQuery } from './members.dto.js';

/**
 * The organization's people: who can see whom, and who may invite.
 *
 * This is the first module to use all three authorization layers together, which is why it
 * exists at this point rather than in step 5:
 *  • **permission** — `user:read` to list, `user:manage` to invite;
 *  • **data scope** — a branch manager sees their branch, an executive sees only themselves;
 *  • **entitlement** — inviting consumes a seat, and the seat count is a plan limit.
 */
const INVITATION_TTL_HOURS = 72;

export interface MemberSummary {
  readonly userId: string;
  readonly membershipId: string;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly isOwner: boolean;
  readonly branchId: string | null;
  readonly teamIds: string[];
  readonly roles: { id: string; code: string; name: string }[];
  readonly lastLoginAt: Date | null;
  readonly joinedAt: Date | null;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly db: DbService,
    private readonly scopes: DataScopeService,
    private readonly entitlements: EntitlementService,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(MAILER) private readonly mailer: MailerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(query: ListMembersQuery): Promise<{
    items: MemberSummary[];
    pagination: { limit: number; nextCursor: string | null; hasMore: boolean; total: number };
  }> {
    const principal = tenantContext.require('members.list');

    // The caller's grant decides the breadth. `user:read` supports scoping, so a sales
    // executive listing "the team" legitimately sees only themselves.
    const filter = this.scopes.filterFor(PERMISSIONS.USER_READ, {
      userColumn: 'userId',
      branchColumn: 'defaultBranchId',
    });

    const baseWhere: Record<string, unknown> = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
    };
    const scopedWhere = applyScopeFilter(baseWhere, filter);
    if (scopedWhere === null) {
      return {
        items: [],
        pagination: { limit: query.limit, nextCursor: null, hasMore: false, total: 0 },
      };
    }

    // Team scope needs the set of colleagues sharing a team, which membership rows do not
    // carry directly.
    if (this.scopes.scopeOf(PERMISSIONS.USER_READ) === 'team' && principal.teamIds.length > 0) {
      const teammates = await this.db.client.teamMember.findMany({
        where: { teamId: { in: [...principal.teamIds] } },
        select: { userId: true },
      });
      const userIds = new Set(teammates.map((row) => row.userId));
      if (principal.actorId) userIds.add(principal.actorId);
      delete scopedWhere['OR'];
      scopedWhere['userId'] = { in: [...userIds] };
    }

    if (query.search) {
      const matching = await withPlatformScope('members: search identities', async () =>
        this.db.client.user.findMany({
          where: {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
          take: 500,
        }),
      );
      const searchIds = matching.map((row) => row.id);
      const existing = scopedWhere['userId'] as { in: string[] } | undefined;
      scopedWhere['userId'] = existing
        ? { in: existing.in.filter((id) => searchIds.includes(id)) }
        : { in: searchIds };
    }

    const [total, rows] = await Promise.all([
      this.db.client.membership.count({ where: scopedWhere }),
      this.db.client.membership.findMany({
        where: scopedWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1, // one extra row answers "is there a next page" without a second count
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    ]);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;

    const userIds = page.map((row) => row.userId);
    const [users, roles, teamMemberships] = await Promise.all([
      withPlatformScope('members: load identities', async () =>
        this.db.client.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true, lastLoginAt: true },
        }),
      ),
      this.db.client.userRole.findMany({
        where: { userId: { in: userIds } },
        include: { role: { select: { id: true, code: true, name: true } } },
      }),
      this.db.client.teamMember.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, teamId: true },
      }),
    ]);

    const userById = new Map(users.map((user) => [user.id, user]));

    return {
      items: page.map((membership) => {
        const user = userById.get(membership.userId);
        return {
          userId: membership.userId,
          membershipId: membership.id,
          name: user?.name ?? 'Unknown',
          email: user?.email ?? '',
          status: membership.status,
          isOwner: membership.isOwner,
          branchId: membership.defaultBranchId,
          teamIds: teamMemberships
            .filter((team) => team.userId === membership.userId)
            .map((team) => team.teamId),
          roles: roles
            .filter((assignment) => assignment.userId === membership.userId)
            .map((assignment) => assignment.role),
          lastLoginAt: user?.lastLoginAt ?? null,
          joinedAt: membership.joinedAt,
        };
      }),
      pagination: {
        limit: query.limit,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
        total,
      },
    };
  }

  /**
   * Invites someone to the organization.
   *
   * Seat accounting counts active members **and** outstanding invitations: otherwise a plan
   * limit of three users could be turned into thirty by sending thirty invitations.
   */
  async invite(input: InviteMemberInput): Promise<{ invitationId: string; expiresAt: Date }> {
    const principal = tenantContext.require('members.invite');
    const organizationId = principal.organizationId;

    const role = await this.db.client.role.findFirst({
      where: { id: input.roleId, deletedAt: null },
    });
    // Tenant scoping means a role id from another organization simply is not found.
    if (!role) throw AppError.notFound('Role');

    if (input.teamId) {
      const team = await this.db.client.team.findFirst({
        where: { id: input.teamId, deletedAt: null },
      });
      if (!team) throw AppError.notFound('Team');
    }
    if (input.branchId) {
      const branch = await this.db.client.branch.findFirst({
        where: { id: input.branchId, deletedAt: null },
      });
      if (!branch) throw AppError.notFound('Branch');
    }

    const [activeMembers, pendingInvitations] = await Promise.all([
      this.db.client.membership.count({
        where: { status: { in: ['active', 'invited'] }, deletedAt: null },
      }),
      this.db.client.invitation.count({
        where: { status: 'pending', revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    ]);
    await this.entitlements.assertWithinLimit('users', activeMembers + pendingInvitations);

    const alreadyMember = await withPlatformScope(
      'members: check existing membership',
      async () => {
        const user = await this.db.client.user.findUnique({ where: { email: input.email } });
        if (!user) return false;
        const membership = await this.db.client.membership.findUnique({
          where: { organizationId_userId: { organizationId, userId: user.id } },
        });
        return membership !== null && membership.deletedAt === null;
      },
    );
    if (alreadyMember) {
      throw AppError.conflict('That person is already a member of this organization');
    }

    const existingInvitation = await this.db.client.invitation.findFirst({
      where: {
        email: input.email,
        status: 'pending',
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (existingInvitation) {
      throw AppError.conflict('An invitation is already pending for that email address');
    }

    const token = newToken(32);
    const invitationId = newId();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3_600_000);

    await this.db.client.$transaction(async (tx) => {
      await tx.invitation.create({
        data: {
          id: invitationId,
          organizationId,
          email: input.email,
          roleId: input.roleId,
          teamId: input.teamId ?? null,
          branchId: input.branchId ?? null,
          tokenHash: TokenService.hashToken(token),
          invitedById: principal.actorId ?? null,
          expiresAt,
        },
      });

      await this.audit.recordInTransaction(tx, {
        action: 'invitation.sent',
        resourceType: 'invitation',
        resourceId: invitationId,
        after: { email: input.email, roleId: input.roleId, roleCode: role.code },
      });

      await this.outbox.emit(tx, [
        {
          name: 'invitation.sent',
          aggregateType: 'invitation',
          aggregateId: invitationId,
          payload: { organizationId, email: input.email, roleId: input.roleId },
        },
      ]);
    });

    await this.mailer.send({
      to: input.email,
      kind: 'invitation',
      subject: 'You have been invited to a workspace',
      text: `You have been invited to join a workspace as ${role.name}.\n\n${this.config.WEB_ORIGIN}/accept-invitation?token=${token}\n\nThis invitation expires in ${INVITATION_TTL_HOURS} hours.`,
    });

    return { invitationId, expiresAt };
  }

  async listInvitations(): Promise<{
    items: {
      id: string;
      email: string;
      roleId: string;
      status: string;
      expiresAt: Date;
      createdAt: Date;
    }[];
  }> {
    const invitations = await this.db.client.invitation.findMany({
      where: { status: 'pending', revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: invitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        roleId: invitation.roleId,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
      })),
    };
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    // Tenant-scoped update: an invitation id from another organization matches nothing.
    const result = await this.db.client.invitation.updateMany({
      where: { id: invitationId, status: 'pending' },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    if (result.count === 0) throw AppError.notFound('Invitation');

    await this.audit.record({
      action: 'invitation.revoked',
      resourceType: 'invitation',
      resourceId: invitationId,
    });
  }

  /** Seat usage, for the UI to show "3 of 15 seats used" before someone hits the limit. */
  async seatUsage(): Promise<{ used: number; limit: number | null; pendingInvitations: number }> {
    const [activeMembers, pendingInvitations, entitlement] = await Promise.all([
      this.db.client.membership.count({
        where: { status: { in: ['active', 'invited'] }, deletedAt: null },
      }),
      this.db.client.invitation.count({
        where: { status: 'pending', revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      this.entitlements.get('users'),
    ]);
    return { used: activeMembers, limit: entitlement.limit, pendingInvitations };
  }

  /** Role changes must invalidate cached grants, or a revoked role keeps working for 5 minutes. */
  async invalidateGrants(): Promise<void> {
    await this.principals.invalidateOrganization(
      tenantContext.require('members.invalidate').organizationId,
    );
  }
}
