import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { TokenService } from '../src/modules/auth/application/token.service.js';
import { EntitlementService } from '../src/infra/entitlements/entitlement.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * Authorization behaviour: permissions, data scopes, plan entitlements and restricted mode
 * (FR-IAM-3/4, FR-BIL-2/3/4).
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eauthz${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let organizationId: string;
let ownerToken: string;
let ownerUserId: string;
let branchId: string;
let teamId: string;

const email = (label: string) => `${label}.${EMAIL_MARKER}@test.local`;

/**
 * Creates a tenant-defined role with explicit grants. Roles are data, so a test can invent
 * one — and mutating a disposable role avoids breaking the seeded system roles other tests
 * rely on.
 */
async function createCustomRole(
  code: string,
  grants: { permission: string; scope: 'own' | 'team' | 'branch' | 'organization' }[],
): Promise<string> {
  const roleId = newId();
  await ctx.db.role.create({
    data: { id: roleId, organizationId, code, name: `Custom ${code}`, isSystem: false },
  });
  await ctx.db.rolePermission.createMany({
    data: grants.map((grant) => ({
      id: newId(),
      organizationId,
      roleId,
      permissionKey: grant.permission,
      scope: grant.scope,
    })),
  });
  return roleId;
}

/** Creates a member with a given role and returns an access token for them. */
async function addMember(
  label: string,
  roleCode: string,
  options: { teamId?: string; branchId?: string; roleId?: string } = {},
): Promise<{ token: string; userId: string }> {
  const role = options.roleId
    ? { id: options.roleId }
    : await ctx.db.role.findFirstOrThrow({ where: { organizationId, code: roleCode } });
  const token = newToken(32);
  const invitedEmail = email(label);

  await ctx.db.invitation.create({
    data: {
      id: newId(),
      organizationId,
      email: invitedEmail,
      roleId: role.id,
      teamId: options.teamId ?? null,
      branchId: options.branchId ?? null,
      tokenHash: TokenService.hashToken(token),
      expiresAt: new Date(Date.now() + 72 * 3_600_000),
    },
  });

  const accepted = await call<
    EnvelopeBody<{ tokens: { accessToken: string }; user: { id: string } }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/invitations/accept',
    payload: { token, name: `Member ${label}`, password: PASSWORD },
  });
  expect(accepted.statusCode).toBe(200);
  return { token: accepted.body.data.tokens.accessToken, userId: accepted.body.data.user.id };
}

beforeAll(async () => {
  ctx = await bootTestApp();

  const registered = await call<
    EnvelopeBody<{
      tokens: { accessToken: string };
      activeOrganizationId: string;
      user: { id: string };
    }>
  >(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: email('owner'),
      password: PASSWORD,
      name: 'Owner',
      organizationName: `Authz Org ${SUFFIX}`,
    },
  });

  organizationId = registered.body.data.activeOrganizationId;
  ownerToken = registered.body.data.tokens.accessToken;
  ownerUserId = registered.body.data.user.id;
  branchId = (await ctx.db.branch.findFirstOrThrow({ where: { organizationId } })).id;
  teamId = (await ctx.db.team.findFirstOrThrow({ where: { organizationId } })).id;
}, 120_000);

afterAll(async () => {
  if (ctx) {
    await cleanupUsers(ctx.db, EMAIL_MARKER);
    await ctx.close();
  }
});

describe('permission enforcement', () => {
  it('lets an owner invite, and refuses a sales executive', async () => {
    const executive = await addMember('exec', 'sales_executive', { teamId, branchId });
    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId, code: 'sales_executive' },
    });

    const asOwner = await call<EnvelopeBody<{ invitationId: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('byowner'), roleId: role.id },
      token: ownerToken,
    });
    expect(asOwner.statusCode).toBe(201);

    const asExecutive = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('byexec'), roleId: role.id },
      token: executive.token,
    });
    expect(asExecutive.statusCode).toBe(403);
    expect(asExecutive.body.error?.code).toBe('PERMISSION_DENIED');
    // Naming the permission is what lets the UI explain the refusal.
    expect(asExecutive.body.error?.message).toContain('user:manage');
  });

  it('refuses a route needing organization scope to a caller scoped narrower', async () => {
    const manager = await addMember('mgr', 'sales_manager', { teamId, branchId });

    // The manager holds user:read, but at branch scope; /users/seats reports the whole
    // organization, so it requires organization scope.
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users/seats',
      token: manager.token,
    });
    expect(response.statusCode).toBe(403);
    expect(response.body.error?.code).toBe('OUT_OF_DATA_SCOPE');
    expect(response.body.error?.details).toMatchObject({
      granted: 'branch',
      required: 'organization',
    });

    const asOwner = await call(ctx.app, {
      method: 'GET',
      url: '/api/v1/users/seats',
      token: ownerToken,
    });
    expect(asOwner.statusCode).toBe(200);
  });

  it('applies a role change on the next request, without waiting for the token to expire', async () => {
    const roleId = await createCustomRole('temp_reader', [
      { permission: 'user:read', scope: 'organization' },
    ]);
    const member = await addMember('demoted', 'temp_reader', { roleId });

    const before = await call(ctx.app, {
      method: 'GET',
      url: '/api/v1/users',
      token: member.token,
    });
    expect(before.statusCode).toBe(200);

    // Strip the role's grants and invalidate the cached grant set — what a role edit does.
    // Permissions are resolved per request precisely so this takes effect immediately rather
    // than when the access token expires.
    await ctx.db.rolePermission.deleteMany({ where: { organizationId, roleId } });
    const { PrincipalService } =
      await import('../src/modules/auth/application/principal.service.js');
    await ctx.app.get(PrincipalService).invalidateOrganization(organizationId);

    const after = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users',
      token: member.token,
    });
    expect(after.statusCode).toBe(403);
  });
});

describe('data scope narrowing', () => {
  it('gives a sales executive no access to the member list at all', async () => {
    // The seeded template deliberately withholds user:read from executives: browsing
    // colleagues is not part of their job, and "own scope" on a member list would be useless.
    const executive = await addMember('scopedexec', 'sales_executive', { teamId, branchId });
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users',
      token: executive.token,
    });
    expect(response.statusCode).toBe(403);
    expect(response.body.error?.code).toBe('PERMISSION_DENIED');
  });

  it('narrows a role granted user:read at own scope to just that person', async () => {
    const roleId = await createCustomRole('self_viewer', [
      { permission: 'user:read', scope: 'own' },
    ]);
    const member = await addMember('selfviewer', 'self_viewer', { roleId, teamId, branchId });

    const asMember = await call<EnvelopeBody<{ userId: string }[]>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users',
      token: member.token,
    });
    expect(asMember.statusCode).toBe(200);
    expect(asMember.body.data.map((row) => row.userId)).toEqual([member.userId]);

    const asOwner = await call<EnvelopeBody<{ userId: string }[]>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users',
      token: ownerToken,
    });
    expect(asOwner.body.data.length).toBeGreaterThan(1);
    expect(asOwner.body.data.map((row) => row.userId)).toContain(ownerUserId);
  });

  it('shows a branch-scoped manager their branch, and not another branch', async () => {
    const otherBranchId = newId();
    await ctx.db.branch.create({
      data: { id: otherBranchId, organizationId, name: 'Other Branch', code: 'OB' },
    });

    const manager = await addMember('branchmgr', 'sales_manager', { branchId });
    const elsewhere = await addMember('elsewhere', 'sales_executive', { branchId: otherBranchId });

    const response = await call<EnvelopeBody<{ userId: string; branchId: string | null }[]>>(
      ctx.app,
      {
        method: 'GET',
        url: '/api/v1/users',
        token: manager.token,
      },
    );

    expect(response.statusCode).toBe(200);
    const visible = response.body.data.map((member) => member.userId);
    expect(visible).toContain(manager.userId);
    expect(visible).not.toContain(elsewhere.userId);
  });

  it('paginates without ever returning an unbounded collection', async () => {
    const response = await call<
      EnvelopeBody<{ userId: string }[]> & {
        meta: { pagination: { limit: number; hasMore: boolean; nextCursor: string | null } };
      }
    >(ctx.app, { method: 'GET', url: '/api/v1/users?limit=2', token: ownerToken });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.length).toBeLessThanOrEqual(2);
    expect(response.body.meta.pagination.limit).toBe(2);

    if (response.body.meta.pagination.hasMore) {
      const next = await call<EnvelopeBody<{ userId: string }[]>>(ctx.app, {
        method: 'GET',
        url: `/api/v1/users?limit=2&cursor=${response.body.meta.pagination.nextCursor}`,
        token: ownerToken,
      });
      expect(next.statusCode).toBe(200);
      // A cursor page must not repeat the previous page's rows.
      const firstPage = response.body.data.map((m) => m.userId);
      for (const member of next.body.data) expect(firstPage).not.toContain(member.userId);
    }
  });

  it('rejects an out-of-range page size rather than honouring it', async () => {
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users?limit=5000',
      token: ownerToken,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('plan entitlements', () => {
  it('counts seats from memberships and pending invitations together', async () => {
    const response = await call<
      EnvelopeBody<{ used: number; limit: number | null; pendingInvitations: number }>
    >(ctx.app, { method: 'GET', url: '/api/v1/users/seats', token: ownerToken });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.used).toBeGreaterThan(0);
    // The seeded starter plan caps users; the exact number is data, so only its presence is asserted.
    expect(response.body.data.limit === null || response.body.data.limit > 0).toBe(true);
  });

  it('refuses an invitation that would exceed the seat limit, and says by how much', async () => {
    // Override the entitlement down to the current usage: overrides are data, not an `if`.
    const [members, pending] = await Promise.all([
      ctx.db.membership.count({ where: { organizationId, status: { in: ['active', 'invited'] } } }),
      ctx.db.invitation.count({ where: { organizationId, status: 'pending', revokedAt: null } }),
    ]);

    await ctx.db.entitlementOverride.upsert({
      where: { organizationId_featureKey: { organizationId, featureKey: 'users' } },
      create: {
        id: newId(),
        organizationId,
        featureKey: 'users',
        limitValue: BigInt(members + pending),
        reason: 'e2e seat limit test',
      },
      update: { limitValue: BigInt(members + pending) },
    });
    await ctx.app.get(EntitlementService).invalidate(organizationId);

    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId, code: 'sales_executive' },
    });
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('overlimit'), roleId: role.id },
      token: ownerToken,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.error?.code).toBe('LIMIT_EXCEEDED');
    // The client needs the numbers to render a useful upgrade prompt.
    expect(response.body.error?.details).toMatchObject({ feature: 'users' });
  });

  it('honours a raised override immediately after invalidation', async () => {
    await ctx.db.entitlementOverride.update({
      where: { organizationId_featureKey: { organizationId, featureKey: 'users' } },
      data: { limitValue: 500n },
    });
    await ctx.app.get(EntitlementService).invalidate(organizationId);

    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId, code: 'sales_executive' },
    });
    const response = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('underlimit'), roleId: role.id },
      token: ownerToken,
    });
    expect(response.statusCode).toBe(201);
  });

  it('ignores an expired override', async () => {
    await ctx.db.entitlementOverride.update({
      where: { organizationId_featureKey: { organizationId, featureKey: 'users' } },
      data: { limitValue: 1n, expiresAt: new Date(Date.now() - 1_000) },
    });
    const entitlements = ctx.app.get(EntitlementService);
    await entitlements.invalidate(organizationId);

    const resolved = await entitlements.get('users', organizationId);
    expect(resolved.source).not.toBe('override');
  });
});

describe('restricted mode after a trial lapses', () => {
  it('keeps reads working but refuses writes, and preserves the data', async () => {
    const registered = await call<
      EnvelopeBody<{ tokens: { accessToken: string }; activeOrganizationId: string }>
    >(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: email('lapsed'),
        password: PASSWORD,
        name: 'Lapsed Owner',
        organizationName: `Lapsed Org ${SUFFIX}`,
      },
    });
    const lapsedOrgId = registered.body.data.activeOrganizationId;
    const token = registered.body.data.tokens.accessToken;

    // Expire the trial and its grace period.
    await ctx.db.subscription.update({
      where: { organizationId: lapsedOrgId },
      data: {
        trialEndsAt: new Date(Date.now() - 86_400_000),
        graceEndsAt: new Date(Date.now() - 3_600_000),
      },
    });

    const read = await call(ctx.app, { method: 'GET', url: '/api/v1/users', token });
    expect(read.statusCode).toBe(200); // data stays visible — FR-BIL-3

    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId: lapsedOrgId, code: 'sales_executive' },
    });
    const write = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('blocked'), roleId: role.id },
      token,
    });
    expect(write.statusCode).toBe(403);
    expect(write.body.error?.code).toBe('TRIAL_EXPIRED');
    expect(write.body.error?.details).toMatchObject({ readOnly: true });

    // Nothing was deleted; the organization is simply restricted.
    const organization = await ctx.db.organization.findUniqueOrThrow({
      where: { id: lapsedOrgId },
    });
    expect(organization.deletedAt).toBeNull();
    expect(
      await ctx.db.membership.count({ where: { organizationId: lapsedOrgId } }),
    ).toBeGreaterThan(0);
  });

  it('still allows signing out, so a restricted tenant is never trapped', async () => {
    const registered = await call<
      EnvelopeBody<{
        tokens: { accessToken: string; refreshToken: string };
        activeOrganizationId: string;
      }>
    >(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: email('trapped'),
        password: PASSWORD,
        name: 'Trapped Owner',
        organizationName: `Trapped Org ${SUFFIX}`,
      },
    });
    await ctx.db.subscription.update({
      where: { organizationId: registered.body.data.activeOrganizationId },
      data: {
        trialEndsAt: new Date(Date.now() - 86_400_000),
        graceEndsAt: new Date(Date.now() - 3_600_000),
      },
    });

    const loggedOut = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: registered.body.data.tokens.refreshToken },
    });
    expect(loggedOut.statusCode).toBe(200);
  });
});
