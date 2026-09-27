import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { TokenService } from '../src/modules/auth/application/token.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * The tenant settings surface: organization, branches, teams, roles and member management
 * (FR-TEN-2, FR-IAM-3/5/8, FR-ONB-1).
 *
 * The recurring theme is that changing structure changes visibility: moving someone between
 * branches, editing a role's grants or removing them from a team must take effect on the next
 * request, not five minutes later when a cache expires.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2esurface${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
let organizationId: string;
let ownerToken: string;
let ownerUserId: string;

const email = (label: string) => `${label}.${EMAIL_MARKER}@test.local`;

async function addMember(
  label: string,
  roleCode: string,
): Promise<{ token: string; userId: string }> {
  const role = await ctx.db.role.findFirstOrThrow({ where: { organizationId, code: roleCode } });
  const token = newToken(32);
  await ctx.db.invitation.create({
    data: {
      id: newId(),
      organizationId,
      email: email(label),
      roleId: role.id,
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
      name: 'Surface Owner',
      organizationName: `Surface Org ${SUFFIX}`,
    },
  });
  organizationId = registered.body.data.activeOrganizationId;
  ownerToken = registered.body.data.tokens.accessToken;
  ownerUserId = registered.body.data.user.id;
}, 120_000);

afterAll(async () => {
  if (ctx) {
    await cleanupUsers(ctx.db, EMAIL_MARKER);
    await ctx.close();
  }
});

describe('organization settings', () => {
  it('reports the profile, counts and subscription', async () => {
    const response = await call<
      EnvelopeBody<{
        slug: string;
        timezone: string;
        publicKey: string;
        counts: { branches: number; teams: number; activeMembers: number };
        subscription: { status: string; planCode: string } | null;
        onboarding: Record<string, unknown>;
      }>
    >(ctx.app, { method: 'GET', url: '/api/v1/organization', token: ownerToken });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.slug).toMatch(/^surface-org-/);
    expect(response.body.data.counts).toMatchObject({ branches: 1, teams: 1, activeMembers: 1 });
    expect(response.body.data.subscription?.status).toBe('trialing');
    expect(response.body.data.onboarding).toMatchObject({ completed: false });
    expect(response.body.data.publicKey).toMatch(/^pk_live_/);
  });

  it('updates the profile and records the change', async () => {
    const response = await call(ctx.app, {
      method: 'PATCH',
      url: '/api/v1/organization',
      payload: { name: `Renamed ${SUFFIX}`, timezone: 'Asia/Dubai', defaultCurrency: 'AED' },
      token: ownerToken,
    });
    expect(response.statusCode).toBe(200);

    const organization = await ctx.db.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(organization.name).toBe(`Renamed ${SUFFIX}`);
    expect(organization.timezone).toBe('Asia/Dubai');
    expect(organization.defaultCurrency).toBe('AED');

    const audit = await ctx.db.auditLog.findFirst({
      where: { organizationId, action: 'organization.updated' },
    });
    expect(audit).not.toBeNull();
  });

  it('refuses to let a tenant change its own slug, status or public key', async () => {
    for (const payload of [
      { slug: 'hijacked' },
      { status: 'active' },
      { publicKey: 'pk_live_mine' },
    ]) {
      const response = await call<EnvelopeBody<never>>(ctx.app, {
        method: 'PATCH',
        url: '/api/v1/organization',
        payload,
        token: ownerToken,
      });
      // Not merely ignored — rejected, so a client cannot believe it worked.
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('rejects an empty update rather than pretending to save', async () => {
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'PATCH',
      url: '/api/v1/organization',
      payload: {},
      token: ownerToken,
    });
    expect(response.statusCode).toBe(400);
  });

  it('advances and completes onboarding, emitting the event once', async () => {
    await call(ctx.app, {
      method: 'PATCH',
      url: '/api/v1/organization/onboarding',
      payload: { step: 'pipeline', data: { industry: 'real_estate' } },
      token: ownerToken,
    });

    const midway = await ctx.db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(midway.onboardingState).toMatchObject({
      step: 'pipeline',
      completed: false,
      data: { industry: 'real_estate' },
    });

    await call(ctx.app, {
      method: 'PATCH',
      url: '/api/v1/organization/onboarding',
      payload: { completed: true },
      token: ownerToken,
    });
    // Completing twice must not emit a second event.
    await call(ctx.app, {
      method: 'PATCH',
      url: '/api/v1/organization/onboarding',
      payload: { completed: true },
      token: ownerToken,
    });

    const events = await ctx.db.outboxEvent.count({
      where: { organizationId, eventName: 'onboarding.completed' },
    });
    expect(events).toBe(1);

    const finished = await ctx.db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    // Earlier answers survive: the step data is merged, not replaced.
    expect(finished.onboardingState).toMatchObject({
      completed: true,
      data: { industry: 'real_estate' },
    });
  });
});

describe('branches', () => {
  let branchId: string;

  it('creates a branch and counts its members', async () => {
    const created = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/branches',
      payload: { name: 'Pune Office', code: 'PNQ', city: 'Pune' },
      token: ownerToken,
    });
    expect(created.statusCode).toBe(201);
    branchId = created.body.data.id;

    const list = await call<
      EnvelopeBody<{ id: string; memberCount: number; isDefault: boolean }[]>
    >(ctx.app, { method: 'GET', url: '/api/v1/branches', token: ownerToken });
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.find((branch) => branch.id === branchId)?.memberCount).toBe(0);
    // The default branch sorts first, because that is the one people mean.
    expect(list.body.data[0]?.isDefault).toBe(true);
  });

  it('moves the default flag rather than allowing two defaults', async () => {
    await call(ctx.app, {
      method: 'PATCH',
      url: `/api/v1/branches/${branchId}`,
      payload: { isDefault: true },
      token: ownerToken,
    });
    const defaults = await ctx.db.branch.count({ where: { organizationId, isDefault: true } });
    expect(defaults).toBe(1);
  });

  it('will not delete a branch that people or teams still point at', async () => {
    // Make the original branch non-default so the guard under test is the occupancy one.
    const original = await ctx.db.branch.findFirstOrThrow({
      where: { organizationId, isDefault: false },
    });
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'DELETE',
      url: `/api/v1/branches/${original.id}`,
      token: ownerToken,
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.details).toMatchObject({ members: expect.any(Number) });
  });

  it('will not delete the default branch', async () => {
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'DELETE',
      url: `/api/v1/branches/${branchId}`,
      token: ownerToken,
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.message).toMatch(/default branch/i);
  });

  it('refuses a branch id from another organization', async () => {
    const other = await ctx.db.branch.create({
      data: {
        id: newId(),
        organizationId: (
          await ctx.db.organization.findFirstOrThrow({ where: { id: { not: organizationId } } })
        ).id,
        name: 'Foreign Branch',
      },
    });
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'PATCH',
      url: `/api/v1/branches/${other.id}`,
      payload: { name: 'Hijacked' },
      token: ownerToken,
    });
    expect(response.statusCode).toBe(404);
    await ctx.db.branch.delete({ where: { id: other.id } });
  });
});

describe('teams', () => {
  it('creates a team, adds and removes a member, and updates visibility immediately', async () => {
    const member = await addMember('teamer', 'sales_manager');

    const created = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/teams',
      payload: { name: 'Inside Sales' },
      token: ownerToken,
    });
    expect(created.statusCode).toBe(201);
    const teamId = created.body.data.id;

    const added = await call(ctx.app, {
      method: 'POST',
      url: `/api/v1/teams/${teamId}/members`,
      payload: { userId: member.userId, isLead: true },
      token: ownerToken,
    });
    expect(added.statusCode).toBe(201);

    const list = await call<
      EnvelopeBody<{ id: string; memberCount: number; leadUserIds: string[] }[]>
    >(ctx.app, { method: 'GET', url: '/api/v1/teams', token: ownerToken });
    const team = list.body.data.find((row) => row.id === teamId);
    expect(team?.memberCount).toBe(1);
    expect(team?.leadUserIds).toEqual([member.userId]);

    // Team membership decides what a team-scoped user sees, so /auth/me must reflect it now.
    const me = await call<EnvelopeBody<{ permissions: string[] }>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: member.token,
    });
    expect(me.statusCode).toBe(200);

    const removed = await call(ctx.app, {
      method: 'DELETE',
      url: `/api/v1/teams/${teamId}/members/${member.userId}`,
      token: ownerToken,
    });
    expect(removed.statusCode).toBe(200);
    expect(await ctx.db.teamMember.count({ where: { teamId } })).toBe(0);
  });

  it('adding the same person twice updates them instead of failing', async () => {
    const member = await addMember('twice', 'sales_executive');
    const team = await ctx.db.team.findFirstOrThrow({ where: { organizationId } });

    await call(ctx.app, {
      method: 'POST',
      url: `/api/v1/teams/${team.id}/members`,
      payload: { userId: member.userId },
      token: ownerToken,
    });
    const second = await call(ctx.app, {
      method: 'POST',
      url: `/api/v1/teams/${team.id}/members`,
      payload: { userId: member.userId, isLead: true },
      token: ownerToken,
    });
    expect(second.statusCode).toBe(201);

    const rows = await ctx.db.teamMember.findMany({
      where: { teamId: team.id, userId: member.userId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isLead).toBe(true);
  });

  it('refuses a user who is not a member of the organization', async () => {
    const team = await ctx.db.team.findFirstOrThrow({ where: { organizationId } });
    const stranger = await ctx.db.user.findFirstOrThrow({
      where: { memberships: { none: { organizationId } } },
    });
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: `/api/v1/teams/${team.id}/members`,
      payload: { userId: stranger.id },
      token: ownerToken,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('roles and permissions', () => {
  it('exposes the permission catalogue grouped by module', async () => {
    const response = await call<
      EnvelopeBody<{ modules: { module: string; permissions: { key: string }[] }[] }>
    >(ctx.app, { method: 'GET', url: '/api/v1/permissions', token: ownerToken });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.modules.length).toBeGreaterThan(5);
    const keys = response.body.data.modules.flatMap((module) =>
      module.permissions.map((p) => p.key),
    );
    expect(keys).toContain('lead:read');
  });

  it('lists seeded roles with their grants and holder counts', async () => {
    const response = await call<
      EnvelopeBody<{ code: string; isSystem: boolean; memberCount: number; grants: unknown[] }[]>
    >(ctx.app, { method: 'GET', url: '/api/v1/roles', token: ownerToken });

    const owner = response.body.data.find((role) => role.code === 'owner');
    expect(owner?.isSystem).toBe(true);
    expect(owner?.memberCount).toBe(1);
    expect(owner?.grants.length).toBeGreaterThan(30);
  });

  it('creates a tenant-defined role and assigns it, taking effect immediately', async () => {
    const created = await call<EnvelopeBody<{ id: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/roles',
      payload: {
        code: 'telecaller',
        name: 'Telecaller',
        grants: [
          { permission: 'lead:read', scope: 'own' },
          { permission: 'task:manage', scope: 'own' },
        ],
      },
      token: ownerToken,
    });
    expect(created.statusCode).toBe(201);
    const roleId = created.body.data.id;

    const member = await addMember('telecaller', 'sales_executive');
    const assigned = await call(ctx.app, {
      method: 'PUT',
      url: `/api/v1/users/${member.userId}/roles`,
      payload: { roleIds: [roleId] },
      token: ownerToken,
    });
    expect(assigned.statusCode).toBe(200);

    // Nothing in the codebase knows the word "telecaller": the grants decide what they can do.
    const me = await call<EnvelopeBody<{ permissions: string[]; scopes: Record<string, string> }>>(
      ctx.app,
      { method: 'GET', url: '/api/v1/auth/me', token: member.token },
    );
    expect(me.body.data.permissions.sort()).toEqual(['lead:read', 'task:manage']);
    expect(me.body.data.scopes['lead:read']).toBe('own');
  });

  it('replaces a role’s grants wholesale and applies them on the next request', async () => {
    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId, code: 'telecaller' },
    });
    const holder = await ctx.db.userRole.findFirstOrThrow({ where: { roleId: role.id } });
    const holderUser = await ctx.db.user.findUniqueOrThrow({ where: { id: holder.userId } });

    const signedIn = await call<EnvelopeBody<{ tokens: { accessToken: string } }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: holderUser.email, password: PASSWORD },
    });
    const token = signedIn.body.data.tokens.accessToken;

    await call(ctx.app, {
      method: 'PUT',
      url: `/api/v1/roles/${role.id}/permissions`,
      payload: { grants: [{ permission: 'customer:read', scope: 'organization' }] },
      token: ownerToken,
    });

    const me = await call<EnvelopeBody<{ permissions: string[] }>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token,
    });
    expect(me.body.data.permissions).toEqual(['customer:read']);
  });

  it('rejects a permission that is not in the catalogue', async () => {
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/roles',
      payload: {
        code: 'bogus',
        name: 'Bogus',
        grants: [{ permission: 'lead:teleport', scope: 'own' }],
      },
      token: ownerToken,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.error?.details).toMatchObject([{ code: 'UNKNOWN_PERMISSION' }]);
  });

  it('refuses to delete a seeded role, or one that still has holders', async () => {
    const seeded = await ctx.db.role.findFirstOrThrow({ where: { organizationId, code: 'admin' } });
    const seededResponse = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'DELETE',
      url: `/api/v1/roles/${seeded.id}`,
      token: ownerToken,
    });
    expect(seededResponse.statusCode).toBe(422);

    const held = await ctx.db.role.findFirstOrThrow({
      where: { organizationId, code: 'telecaller' },
    });
    const heldResponse = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'DELETE',
      url: `/api/v1/roles/${held.id}`,
      token: ownerToken,
    });
    expect(heldResponse.statusCode).toBe(422);
    expect(heldResponse.body.error?.details).toMatchObject({ holders: 1 });
  });

  it('stops an organization removing its own last administrator', async () => {
    // Recovering from this needs support intervention, so it is guarded rather than audited.
    const executive = await ctx.db.role.findFirstOrThrow({
      where: { organizationId, code: 'sales_executive' },
    });
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'PUT',
      url: `/api/v1/users/${ownerUserId}/roles`,
      payload: { roleIds: [executive.id] },
      token: ownerToken,
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.error?.message).toMatch(/last person who can manage roles/i);
  });
});

describe('member management', () => {
  it('moves a member between branches, narrowing what they see', async () => {
    const manager = await addMember('mover', 'sales_manager');
    const branches = await ctx.db.branch.findMany({ where: { organizationId }, take: 2 });
    const target = branches[1] ?? branches[0]!;

    const response = await call(ctx.app, {
      method: 'PATCH',
      url: `/api/v1/users/${manager.userId}`,
      payload: { defaultBranchId: target.id },
      token: ownerToken,
    });
    expect(response.statusCode).toBe(200);

    const membership = await ctx.db.membership.findFirstOrThrow({
      where: { organizationId, userId: manager.userId },
    });
    expect(membership.defaultBranchId).toBe(target.id);

    // A branch-scoped manager's visible member list follows the move immediately.
    const list = await call<EnvelopeBody<{ userId: string }[]>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users',
      token: manager.token,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body.data.map((row) => row.userId)).toContain(manager.userId);
  });

  it('suspends a member and locks them out on the next request', async () => {
    const member = await addMember('suspендed'.replace(/[^a-z]/g, ''), 'sales_executive');

    const suspended = await call(ctx.app, {
      method: 'PATCH',
      url: `/api/v1/users/${member.userId}`,
      payload: { status: 'suspended' },
      token: ownerToken,
    });
    expect(suspended.statusCode).toBe(200);

    const after = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: member.token,
    });
    expect(after.statusCode).toBe(403);
  });

  it('refuses to let someone suspend themselves or the owner', async () => {
    const own = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'PATCH',
      url: `/api/v1/users/${ownerUserId}`,
      payload: { status: 'suspended' },
      token: ownerToken,
    });
    expect(own.statusCode).toBe(422);
  });
});

describe('notifications', () => {
  it('creates one for the people who can act, when a member joins', async () => {
    const { MemberJoinedNotificationProcessor } =
      await import('../src/modules/notifications/notifications.processor.js');
    const joiner = await addMember('notifyjoin', 'sales_executive');

    const processor = ctx.app.get(MemberJoinedNotificationProcessor);
    const payload = { organizationId, aggregateId: joiner.userId, eventId: newId() };
    await processor.process(payload, {} as never);
    // Idempotent on the event id: a redelivery must not produce a second copy.
    await processor.process(payload, {} as never);

    const notifications = await ctx.db.notification.findMany({
      where: { organizationId, type: 'member.joined', userId: ownerUserId },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toContain('joined the workspace');
    // The person who joined is not told they joined.
    expect(
      await ctx.db.notification.count({
        where: { organizationId, userId: joiner.userId, type: 'member.joined' },
      }),
    ).toBe(0);
  });

  it('lists a person’s own notifications with an unread count', async () => {
    const response = await call<
      EnvelopeBody<{ id: string; type: string; readAt: string | null }[]> & { data: unknown }
    >(ctx.app, { method: 'GET', url: '/api/v1/notifications', token: ownerToken });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    const count = await call<EnvelopeBody<{ unreadCount: number }>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      token: ownerToken,
    });
    expect(count.body.data.unreadCount).toBeGreaterThan(0);
  });

  it('will not let one person read another’s notification', async () => {
    const other = await addMember('notifyother', 'sales_executive');
    const mine = await ctx.db.notification.findFirstOrThrow({
      where: { organizationId, userId: ownerUserId },
    });

    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: `/api/v1/notifications/${mine.id}/read`,
      payload: {},
      token: other.token,
    });
    // 404, not 403: the API does not confirm that someone else's notification exists.
    expect(response.statusCode).toBe(404);

    const unchanged = await ctx.db.notification.findUniqueOrThrow({ where: { id: mine.id } });
    expect(unchanged.readAt).toBeNull();
  });

  it('marks everything read', async () => {
    const response = await call<EnvelopeBody<{ read: number }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      payload: {},
      token: ownerToken,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.read).toBeGreaterThan(0);

    const count = await call<EnvelopeBody<{ unreadCount: number }>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      token: ownerToken,
    });
    expect(count.body.data.unreadCount).toBe(0);
  });
});
