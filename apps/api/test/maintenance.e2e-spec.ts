import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import {
  InvitationExpiryProcessor,
  OutboxReapProcessor,
  SessionPruneProcessor,
  TrialCheckProcessor,
} from '../src/modules/maintenance/maintenance.processors.js';
import { TokenService } from '../src/modules/auth/application/token.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * Scheduled housekeeping (FR-BIL-3, docs/queue-event-architecture.md §5).
 *
 * The trial lifecycle is the one that changes what a customer can do, so it gets the most
 * attention: a trial must enter a grace period rather than stopping work the moment it ends, and
 * expiry must restrict writes without deleting anything.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2emaint${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;
const email = (label: string) => `${label}.${EMAIL_MARKER}@test.local`;
const noJob = {} as never;

async function registerOrg(
  label: string,
): Promise<{ organizationId: string; token: string; userId: string }> {
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
      email: email(label),
      password: PASSWORD,
      name: `Owner ${label}`,
      organizationName: `Maint ${label} ${SUFFIX}`,
    },
  });
  return {
    organizationId: registered.body.data.activeOrganizationId,
    token: registered.body.data.tokens.accessToken,
    userId: registered.body.data.user.id,
  };
}

beforeAll(async () => {
  ctx = await bootTestApp();
}, 120_000);

afterAll(async () => {
  if (ctx) {
    await ctx.db.jobFailure.deleteMany({ where: { queue: 'outbox' } });
    await cleanupUsers(ctx.db, EMAIL_MARKER);
    await ctx.close();
  }
});

describe('trial lifecycle', () => {
  it('gives a lapsed trial a grace period instead of stopping work immediately', async () => {
    const org = await registerOrg('grace');
    await ctx.db.subscription.update({
      where: { organizationId: org.organizationId },
      data: { trialEndsAt: new Date(Date.now() - 3_600_000), graceEndsAt: null },
    });

    await ctx.app.get(TrialCheckProcessor).process({ organizationId: null }, noJob);

    const subscription = await ctx.db.subscription.findUniqueOrThrow({
      where: { organizationId: org.organizationId },
    });
    expect(subscription.status).toBe('trialing');
    expect(subscription.graceEndsAt).not.toBeNull();
    expect(subscription.graceEndsAt!.getTime()).toBeGreaterThan(Date.now());

    // Still writable during grace: the customer gets a runway, not a wall.
    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId: org.organizationId, code: 'sales_executive' },
    });
    const write = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('duringgrace'), roleId: role.id },
      token: org.token,
    });
    expect(write.statusCode).toBe(201);
  });

  it('expires a subscription once its grace period ends, preserving the data', async () => {
    const org = await registerOrg('expire');
    await ctx.db.subscription.update({
      where: { organizationId: org.organizationId },
      data: {
        trialEndsAt: new Date(Date.now() - 7 * 86_400_000),
        graceEndsAt: new Date(Date.now() - 3_600_000),
      },
    });

    await ctx.app.get(TrialCheckProcessor).process({ organizationId: null }, noJob);

    const subscription = await ctx.db.subscription.findUniqueOrThrow({
      where: { organizationId: org.organizationId },
    });
    expect(subscription.status).toBe('expired');

    // Nothing deleted, and the event recorded for whoever notifies the customer (FR-BIL-3).
    const [organization, members, event] = await Promise.all([
      ctx.db.organization.findUniqueOrThrow({ where: { id: org.organizationId } }),
      ctx.db.membership.count({ where: { organizationId: org.organizationId } }),
      ctx.db.outboxEvent.findFirst({
        where: { organizationId: org.organizationId, eventName: 'trial.expired' },
      }),
    ]);
    expect(organization.deletedAt).toBeNull();
    expect(members).toBeGreaterThan(0);
    expect(event).not.toBeNull();

    // Reads keep working; writes do not.
    const read = await call(ctx.app, { method: 'GET', url: '/api/v1/users', token: org.token });
    expect(read.statusCode).toBe(200);

    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId: org.organizationId, code: 'sales_executive' },
    });
    const write = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('afterexpiry'), roleId: role.id },
      token: org.token,
    });
    expect(write.statusCode).toBe(403);
    expect(write.body.error?.code).toBe('SUBSCRIPTION_INACTIVE');
  });

  it('is idempotent: running twice does not re-expire or duplicate events', async () => {
    const org = await registerOrg('idem');
    await ctx.db.subscription.update({
      where: { organizationId: org.organizationId },
      data: {
        trialEndsAt: new Date(Date.now() - 7 * 86_400_000),
        graceEndsAt: new Date(Date.now() - 3_600_000),
      },
    });

    const processor = ctx.app.get(TrialCheckProcessor);
    await processor.process({ organizationId: null }, noJob);
    await processor.process({ organizationId: null }, noJob);

    const events = await ctx.db.outboxEvent.count({
      where: { organizationId: org.organizationId, eventName: 'trial.expired' },
    });
    expect(events).toBe(1);
  });

  it('leaves an active subscription alone', async () => {
    const org = await registerOrg('active');
    await ctx.db.subscription.update({
      where: { organizationId: org.organizationId },
      data: { status: 'active', trialEndsAt: null, graceEndsAt: null },
    });

    await ctx.app.get(TrialCheckProcessor).process({ organizationId: null }, noJob);

    const subscription = await ctx.db.subscription.findUniqueOrThrow({
      where: { organizationId: org.organizationId },
    });
    expect(subscription.status).toBe('active');
  });
});

describe('invitation expiry', () => {
  it('marks a lapsed invitation expired and frees the seat it was holding', async () => {
    const org = await registerOrg('inviteexpiry');
    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId: org.organizationId, code: 'sales_executive' },
    });

    const invitationId = newId();
    await ctx.db.invitation.create({
      data: {
        id: invitationId,
        organizationId: org.organizationId,
        email: email('stale'),
        roleId: role.id,
        tokenHash: TokenService.hashToken(newToken(32)),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const before = await call<EnvelopeBody<{ pendingInvitations: number }>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users/seats',
      token: org.token,
    });

    await ctx.app.get(InvitationExpiryProcessor).process({ organizationId: null }, noJob);

    const invitation = await ctx.db.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(invitation.status).toBe('expired');

    const after = await call<EnvelopeBody<{ pendingInvitations: number }>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/users/seats',
      token: org.token,
    });
    // Seat accounting must not be held hostage by invitations nobody will accept.
    expect(after.body.data.pendingInvitations).toBeLessThanOrEqual(
      before.body.data.pendingInvitations,
    );
  });

  it('leaves a live invitation pending', async () => {
    const org = await registerOrg('liveinvite');
    const role = await ctx.db.role.findFirstOrThrow({
      where: { organizationId: org.organizationId, code: 'sales_executive' },
    });
    const created = await call<EnvelopeBody<{ invitationId: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/users/invitations',
      payload: { email: email('livetarget'), roleId: role.id },
      token: org.token,
    });

    await ctx.app.get(InvitationExpiryProcessor).process({ organizationId: null }, noJob);

    const invitation = await ctx.db.invitation.findUniqueOrThrow({
      where: { id: created.body.data.invitationId },
    });
    expect(invitation.status).toBe('pending');
  });
});

describe('session pruning', () => {
  it('removes long-expired sessions and keeps live ones', async () => {
    const org = await registerOrg('prune');

    const staleId = newId();
    await ctx.db.session.create({
      data: {
        id: staleId,
        userId: org.userId,
        familyId: staleId,
        refreshTokenHash: TokenService.hashToken(newToken(32)),
        expiresAt: new Date(Date.now() - 60 * 86_400_000),
      },
    });

    const liveBefore = await ctx.db.session.count({
      where: { userId: org.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });

    await ctx.app.get(SessionPruneProcessor).process({ organizationId: null }, noJob);

    expect(await ctx.db.session.findUnique({ where: { id: staleId } })).toBeNull();
    const liveAfter = await ctx.db.session.count({
      where: { userId: org.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(liveAfter).toBe(liveBefore);
  });
});

describe('outbox reaper', () => {
  beforeAll(async () => {
    // This database accumulates undispatched events from other suites, and the reaper reports the
    // oldest hundred. Clearing the backlog makes the assertions about *this* event meaningful.
    await ctx.db.outboxEvent.updateMany({
      where: { publishedAt: null },
      data: { publishedAt: new Date() },
    });
    await ctx.db.jobFailure.deleteMany({ where: { queue: 'outbox' } });
  });

  it('surfaces an undispatched event where an operator can see it', async () => {
    const org = await registerOrg('reap');
    const eventId = newId();

    await ctx.db.outboxEvent.create({
      data: {
        id: newId(),
        eventId,
        organizationId: org.organizationId,
        eventName: 'invitation.sent',
        aggregateType: 'test',
        aggregateId: newId(),
        payload: { note: 'stuck' },
        actorType: 'system',
        // Older than the stuck threshold, and never published.
        occurredAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    await ctx.app.get(OutboxReapProcessor).process({ organizationId: null }, noJob);

    const failure = await ctx.db.jobFailure.findFirst({
      where: { queue: 'outbox', jobId: eventId },
    });
    expect(failure).not.toBeNull();
    expect(failure?.jobName).toBe('invitation.sent');

    // Idempotent: a second pass must not pile up duplicate rows for the same stuck event.
    await ctx.app.get(OutboxReapProcessor).process({ organizationId: null }, noJob);
    expect(await ctx.db.jobFailure.count({ where: { queue: 'outbox', jobId: eventId } })).toBe(1);
  });

  it('says nothing when the outbox is flowing', async () => {
    await ctx.db.jobFailure.deleteMany({ where: { queue: 'outbox' } });
    // Everything recent: nothing is stuck, so nothing should be reported.
    await ctx.db.outboxEvent.updateMany({
      where: { publishedAt: null },
      data: { occurredAt: new Date() },
    });

    await ctx.app.get(OutboxReapProcessor).process({ organizationId: null }, noJob);
    expect(await ctx.db.jobFailure.count({ where: { queue: 'outbox' } })).toBe(0);
  });
});
