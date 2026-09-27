import { Injectable } from '@nestjs/common';
import {
  AppError,
  PERMISSIONS,
  newId,
  tenantContext,
  withPlatformScope,
  type DataScope,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import { fullPage } from '../organizations/organizations.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { PrincipalService } from '../auth/application/principal.service.js';
import type {
  CreateRoleInput,
  SetRoleGrantsInput,
  SetUserRolesInput,
  UpdateMemberInput,
  UpdateRoleInput,
} from './iam.dto.js';

/**
 * Roles, grants and who holds them.
 *
 * This is the module that makes "roles are data, not code" usable: a tenant can invent a role,
 * choose its permissions and their scopes, and assign it — with nothing in the codebase referring to
 * it by name (FR-IAM-3).
 *
 * Every mutation here changes what somebody can see or do, so every one of them invalidates the
 * cached grants. The alternative is a revoked permission that keeps working for five minutes.
 */
@Injectable()
export class IamService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly principals: PrincipalService,
  ) {}

  /** The permission catalogue, grouped for a settings screen. */
  async listPermissions() {
    const permissions = await withPlatformScope('iam: list permission catalogue', async () =>
      this.db.client.permission.findMany({ orderBy: [{ module: 'asc' }, { key: 'asc' }] }),
    );
    const byModule = new Map<string, typeof permissions>();
    for (const permission of permissions) {
      byModule.set(permission.module, [...(byModule.get(permission.module) ?? []), permission]);
    }
    return {
      modules: [...byModule.entries()].map(([module, entries]) => ({
        module,
        permissions: entries.map((entry) => ({
          key: entry.key,
          description: entry.description,
          supportsScope: entry.supportsScope,
        })),
      })),
    };
  }

  async listRoles() {
    const roles = await this.db.client.role.findMany({
      where: { deletedAt: null },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });
    const holders = await this.db.client.userRole.groupBy({
      by: ['roleId'],
      _count: { _all: true },
    });
    const byRole = new Map(holders.map((row) => [row.roleId, row._count._all]));

    const items = roles.map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      isEditable: role.isEditable,
      memberCount: byRole.get(role.id) ?? 0,
      grants: role.permissions.map((grant) => ({
        permission: grant.permissionKey,
        scope: grant.scope,
      })),
    }));
    return { items, pagination: fullPage(items.length) };
  }

  async createRole(input: CreateRoleInput) {
    const existing = await this.db.client.role.findFirst({ where: { code: input.code } });
    if (existing) throw AppError.conflict('A role with that code already exists');

    if (input.grants?.length)
      await this.assertPermissionsExist(input.grants.map((g) => g.permission));

    const roleId = newId();
    await this.db.client.$transaction(async (tx) => {
      await tx.role.create({
        data: {
          id: roleId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          isSystem: false,
        } as never,
      });
      if (input.grants?.length) {
        await tx.rolePermission.createMany({
          data: input.grants.map((grant) => ({
            id: newId(),
            roleId,
            permissionKey: grant.permission,
            scope: grant.scope as DataScope,
          })) as never,
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'role.created',
        resourceType: 'role',
        resourceId: roleId,
        after: { code: input.code, grants: input.grants?.length ?? 0 },
      });
    });

    return { id: roleId, code: input.code };
  }

  async updateRole(roleId: string, input: UpdateRoleInput) {
    const role = await this.requireRole(roleId);
    // System roles are editable by design — a tenant may rename "Sales Executive" to "Telecaller" —
    // but `isEditable: false` exists for any role the platform later needs to pin.
    if (!role.isEditable) throw AppError.businessRule('This role cannot be edited');

    await this.db.client.$transaction(async (tx) => {
      await tx.role.update({ where: { id: roleId }, data: input as never });
      await this.audit.recordInTransaction(tx, {
        action: 'role.updated',
        resourceType: 'role',
        resourceId: roleId,
        before: { name: role.name, description: role.description },
        after: input as Record<string, unknown>,
      });
    });
    return { id: roleId };
  }

  /** Replaces a role's grants wholesale: a settings screen submits the intended final state. */
  async setRoleGrants(roleId: string, input: SetRoleGrantsInput) {
    const role = await this.requireRole(roleId);
    if (!role.isEditable) throw AppError.businessRule('This role cannot be edited');
    await this.assertPermissionsExist(input.grants.map((grant) => grant.permission));

    const organizationId = tenantContext.organizationId('iam.setRoleGrants');
    await this.guardAgainstLockingOutTheLastAdministrator(roleId, input.grants);

    const before = await this.db.client.rolePermission.findMany({
      where: { roleId },
      select: { permissionKey: true, scope: true },
    });

    await this.db.client.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (input.grants.length > 0) {
        await tx.rolePermission.createMany({
          data: input.grants.map((grant) => ({
            id: newId(),
            organizationId,
            roleId,
            permissionKey: grant.permission,
            scope: grant.scope as DataScope,
          })),
        });
      }
      await this.audit.recordInTransaction(tx, {
        action: 'role.grants_changed',
        resourceType: 'role',
        resourceId: roleId,
        before: { grants: before },
        after: { grants: input.grants },
      });
    });

    await this.invalidate();
    return { id: roleId, grants: input.grants.length };
  }

  async deleteRole(roleId: string) {
    const role = await this.requireRole(roleId);
    if (role.isSystem) throw AppError.businessRule('Seeded roles cannot be deleted, only edited');

    const holders = await this.db.client.userRole.count({ where: { roleId } });
    if (holders > 0) {
      throw AppError.businessRule('Move the people holding this role to another role first', {
        holders,
      });
    }
    const pendingInvitations = await this.db.client.invitation.count({
      where: { roleId, status: 'pending' },
    });
    if (pendingInvitations > 0) {
      throw AppError.businessRule('Revoke the pending invitations for this role first', {
        pendingInvitations,
      });
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.role.update({ where: { id: roleId }, data: { deletedAt: new Date() } });
      await this.audit.recordInTransaction(tx, {
        action: 'role.deleted',
        resourceType: 'role',
        resourceId: roleId,
        before: { code: role.code },
      });
    });
    await this.invalidate();
    return { deleted: true };
  }

  async setUserRoles(userId: string, input: SetUserRolesInput) {
    const organizationId = tenantContext.organizationId('iam.setUserRoles');
    const membership = await this.db.client.membership.findFirst({
      where: { userId, deletedAt: null },
    });
    if (!membership) throw AppError.notFound('Member');

    const roles = await this.db.client.role.findMany({
      where: { id: { in: input.roleIds }, deletedAt: null },
    });
    // A role id from another organization is simply not found, so the count check is the guard.
    if (roles.length !== new Set(input.roleIds).size) throw AppError.notFound('Role');

    await this.guardAgainstRemovingTheLastAdministrator(userId, input.roleIds);

    const before = await this.db.client.userRole.findMany({
      where: { userId },
      select: { roleId: true },
    });

    await this.db.client.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({
        data: input.roleIds.map((roleId) => ({ id: newId(), organizationId, userId, roleId })),
      });
      await this.audit.recordInTransaction(tx, {
        action: 'user.roles_changed',
        resourceType: 'user',
        resourceId: userId,
        before: { roleIds: before.map((row) => row.roleId) },
        after: { roleIds: input.roleIds },
      });
    });

    await this.invalidate();
    return { userId, roleIds: input.roleIds };
  }

  /** Branch reassignment and suspension. Both change what the person can reach. */
  async updateMember(userId: string, input: UpdateMemberInput) {
    const membership = await this.db.client.membership.findFirst({
      where: { userId, deletedAt: null },
    });
    if (!membership) throw AppError.notFound('Member');

    const principal = tenantContext.require('iam.updateMember');
    if (input.status === 'suspended') {
      if (userId === principal.actorId) {
        throw AppError.businessRule('You cannot suspend your own access');
      }
      if (membership.isOwner) {
        throw AppError.businessRule('The owner’s access cannot be suspended');
      }
    }
    if (input.defaultBranchId) {
      const branch = await this.db.client.branch.findFirst({
        where: { id: input.defaultBranchId, deletedAt: null },
      });
      if (!branch) throw AppError.notFound('Branch');
    }

    await this.db.client.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: membership.id }, data: input as never });
      await this.audit.recordInTransaction(tx, {
        action: input.status === 'suspended' ? 'user.suspended' : 'user.updated',
        resourceType: 'user',
        resourceId: userId,
        before: { status: membership.status, defaultBranchId: membership.defaultBranchId },
        after: input as Record<string, unknown>,
      });
    });

    await this.invalidate();
    return { userId };
  }

  // ── Guards that stop an organization locking itself out ────────────────────

  /**
   * An organization with nobody able to manage users or roles needs support intervention to
   * recover. Cheap to check, expensive to miss — so both paths that could cause it are guarded.
   */
  private async guardAgainstLockingOutTheLastAdministrator(
    roleId: string,
    grants: readonly { permission: string }[],
  ): Promise<void> {
    const keeps = grants.some((grant) => grant.permission === PERMISSIONS.ROLE_MANAGE);
    if (keeps) return;

    const otherAdminRoleIds = await this.db.client.rolePermission.findMany({
      where: { permissionKey: PERMISSIONS.ROLE_MANAGE, roleId: { not: roleId } },
      select: { roleId: true },
    });
    if (otherAdminRoleIds.length > 0) return;

    const holders = await this.db.client.userRole.count({ where: { roleId } });
    if (holders > 0) {
      throw AppError.businessRule(
        'This is the only role that can manage roles. Grant role management to another role first.',
      );
    }
  }

  private async guardAgainstRemovingTheLastAdministrator(
    userId: string,
    nextRoleIds: readonly string[],
  ): Promise<void> {
    const adminRoles = await this.db.client.rolePermission.findMany({
      where: { permissionKey: PERMISSIONS.ROLE_MANAGE },
      select: { roleId: true },
    });
    const adminRoleIds = new Set(adminRoles.map((row) => row.roleId));
    if (adminRoleIds.size === 0) return;
    if (nextRoleIds.some((roleId) => adminRoleIds.has(roleId))) return;

    const otherAdministrators = await this.db.client.userRole.count({
      where: { roleId: { in: [...adminRoleIds] }, userId: { not: userId } },
    });
    if (otherAdministrators === 0) {
      throw AppError.businessRule(
        'This is the last person who can manage roles. Give someone else that access first.',
      );
    }
  }

  private async requireRole(roleId: string) {
    const role = await this.db.client.role.findFirst({ where: { id: roleId, deletedAt: null } });
    if (!role) throw AppError.notFound('Role');
    return role;
  }

  private async assertPermissionsExist(keys: readonly string[]): Promise<void> {
    const unique = [...new Set(keys)];
    const known = await withPlatformScope('iam: validate permission keys', async () =>
      this.db.client.permission.findMany({ where: { key: { in: unique } }, select: { key: true } }),
    );
    const missing = unique.filter((key) => !known.some((row) => row.key === key));
    if (missing.length > 0) {
      throw AppError.validation('Unknown permissions', [
        {
          field: 'grants',
          code: 'UNKNOWN_PERMISSION',
          message: `Not in the catalogue: ${missing.join(', ')}`,
        },
      ]);
    }
  }

  private async invalidate(): Promise<void> {
    await this.principals.invalidateOrganization(tenantContext.organizationId('iam.invalidate'));
  }
}
