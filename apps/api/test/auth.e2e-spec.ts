import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newToken } from '@leados/shared';
import { TokenService } from '../src/modules/auth/application/token.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * End-to-end authentication flows (FR-IAM-1, FR-IAM-2, FR-IAM-7).
 *
 * These run against the assembled application and a real database, because the properties
 * being tested are emergent: registration provisions an entire organization, refresh
 * rotation spans two requests, and reuse detection depends on persisted state.
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2eauth${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;

interface AuthPayload {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  tokens: { accessToken: string; refreshToken: string; expiresIn: number; tokenType: string };
  activeOrganizationId: string;
  organization?: { id: string; slug: string };
}

const email = (label: string) => `${label}.${EMAIL_MARKER}@test.local`;

async function register(label: string, overrides: Record<string, unknown> = {}) {
  return call<EnvelopeBody<AuthPayload>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: email(label),
      password: PASSWORD,
      name: 'Test Owner',
      organizationName: `Test Org ${label} ${SUFFIX}`,
      ...overrides,
    },
  });
}

beforeAll(async () => {
  ctx = await bootTestApp();
}, 90_000);

afterAll(async () => {
  if (ctx) {
    await cleanupUsers(ctx.db, EMAIL_MARKER);
    await ctx.close();
  }
});

describe('POST /auth/register', () => {
  it('provisions a complete, usable organization — not just a row', async () => {
    const response = await register('owner');
    expect(response.statusCode).toBe(201);
    expect(response.body.success).toBe(true);

    const organizationId = response.body.data.activeOrganizationId;
    const slug = response.body.data.organization?.slug;
    expect(organizationId).toBeTruthy();
    expect(slug).toMatch(/^test-org-owner-/);

    // Everything a first login needs must already exist (FR-TEN-2, FR-IAM-5, FR-BIL-3).
    const [branches, teams, roles, membership, subscription, grants] = await Promise.all([
      ctx.db.branch.findMany({ where: { organizationId } }),
      ctx.db.team.findMany({ where: { organizationId } }),
      ctx.db.role.findMany({ where: { organizationId } }),
      ctx.db.membership.findFirstOrThrow({ where: { organizationId } }),
      ctx.db.subscription.findUnique({ where: { organizationId } }),
      ctx.db.rolePermission.count({ where: { organizationId } }),
    ]);

    expect(branches).toHaveLength(1);
    expect(branches[0]?.isDefault).toBe(true);
    expect(teams).toHaveLength(1);
    expect(roles.map((role) => role.code).sort()).toEqual(
      ['admin', 'auditor', 'marketing_manager', 'owner', 'sales_executive', 'sales_manager'].sort(),
    );
    expect(membership.isOwner).toBe(true);
    expect(subscription?.status).toBe('trialing');
    expect(subscription?.trialEndsAt).toBeInstanceOf(Date);
    expect(grants).toBeGreaterThan(50);
  });

  it('writes the creation to the audit trail and the outbox', async () => {
    const response = await register('audited');
    const organizationId = response.body.data.activeOrganizationId;

    const [audit, outbox] = await Promise.all([
      ctx.db.auditLog.findFirst({ where: { organizationId, action: 'organization.created' } }),
      ctx.db.outboxEvent.findFirst({
        where: { organizationId, eventName: 'organization.created' },
      }),
    ]);

    expect(audit).not.toBeNull();
    expect(outbox).not.toBeNull();
    // Not yet dispatched: the dispatcher lands in step 4, and /health/deep reports the lag.
    expect(outbox?.publishedAt).toBeNull();
  });

  it('rejects a weak password with a field-level message', async () => {
    const response = await register('weak', { password: 'password123' });
    expect(response.statusCode).toBe(400);
    expect(response.body.error?.code).toBe('VALIDATION_FAILED');
    expect(response.body.error?.details).toMatchObject([{ field: 'password' }]);
  });

  it('tells a returning user to sign in instead of silently failing', async () => {
    await register('duplicate');
    const second = await register('duplicate');
    expect(second.statusCode).toBe(409);
    expect(second.body.error?.message).toMatch(/already exists/i);
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const response = await register('strict', { isAdmin: true });
    expect(response.statusCode).toBe(400);
  });

  it('gives two organizations with the same name distinct slugs', async () => {
    const first = await register('samename', { organizationName: `Shared Name ${SUFFIX}` });
    const second = await register('samename2', { organizationName: `Shared Name ${SUFFIX}` });
    expect(first.body.data.organization?.slug).not.toBe(second.body.data.organization?.slug);
  });
});

describe('POST /auth/login', () => {
  beforeAll(async () => {
    await register('login');
  });

  it('signs in with correct credentials', async () => {
    const response = await call<EnvelopeBody<AuthPayload>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('login'), password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.tokens.accessToken).toBeTruthy();
    expect(response.body.data.activeOrganizationId).toBeTruthy();
  });

  it('sets the refresh token in an httpOnly cookie, scoped to the auth path', async () => {
    const response = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('login'), password: PASSWORD },
    });
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('leados_rt=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/v1/auth');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrongPassword = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('login'), password: 'definitely not the password' },
    });
    const unknownAccount = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: `nobody.${EMAIL_MARKER}@test.local`, password: PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAccount.statusCode).toBe(401);
    // Identical message: the endpoint must not become an account-enumeration oracle.
    expect(wrongPassword.body.error?.message).toBe(unknownAccount.body.error?.message);
  });

  it('records a failed attempt in the audit trail', async () => {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('login') } });
    await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('login'), password: 'wrong again' },
    });
    const audit = await ctx.db.auditLog.findFirst({
      where: { actorId: user.id, action: 'auth.login_failed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('refuses a disabled account', async () => {
    await register('disabled');
    await ctx.db.user.update({ where: { email: email('disabled') }, data: { status: 'disabled' } });

    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('disabled'), password: PASSWORD },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('refresh token rotation', () => {
  it('rotates on every use', async () => {
    const registered = await register('rotate');
    const first = registered.body.data.tokens.refreshToken;

    const response = await call<EnvelopeBody<{ tokens: { refreshToken: string } }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.tokens.refreshToken).not.toBe(first);
  });

  it('detects reuse and revokes the whole family', async () => {
    // The theft scenario: an attacker replays a token the real client already rotated.
    const registered = await register('reuse');
    const stolen = registered.body.data.tokens.refreshToken;

    const legitimate = await call<EnvelopeBody<{ tokens: { refreshToken: string } }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: stolen },
    });
    const successor = legitimate.body.data.tokens.refreshToken;

    const replay = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: stolen },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.body.error?.code).toBe('TOKEN_REUSED');

    // And the successor is dead too: nothing descended from that login is trusted.
    const afterRevocation = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: successor },
    });
    expect(afterRevocation.statusCode).toBe(401);

    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('reuse') } });
    const live = await ctx.db.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(0);
  });

  it('rejects an unknown refresh token', async () => {
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: newToken(32) },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the refresh token from the cookie when no body is sent', async () => {
    const registered = await register('cookie');
    const token = registered.body.data.tokens.refreshToken;

    const response = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: {},
      headers: { cookie: `leados_rt=${encodeURIComponent(token)}` },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('authenticated access', () => {
  let tokens: AuthPayload['tokens'];
  let organizationId: string;

  beforeAll(async () => {
    const registered = await register('session');
    tokens = registered.body.data.tokens;
    organizationId = registered.body.data.activeOrganizationId;
  });

  it('requires a token: unauthenticated requests are refused by default', async () => {
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
    });
    expect(response.statusCode).toBe(401);
    expect(response.body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('describes the caller, their organizations and their resolved permissions', async () => {
    const response = await call<
      EnvelopeBody<{
        user: { email: string; mfaEnabled: boolean };
        organizations: { id: string; isOwner: boolean }[];
        activeOrganizationId: string;
        permissions: string[];
        scopes: Record<string, string>;
      }>
    >(ctx.app, { method: 'GET', url: '/api/v1/auth/me', token: tokens.accessToken });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.user.email).toBe(email('session'));
    expect(response.body.data.activeOrganizationId).toBe(organizationId);
    expect(response.body.data.organizations[0]?.isOwner).toBe(true);
    // The owner template grants everything, at organization scope.
    expect(response.body.data.permissions).toContain('lead:read');
    expect(response.body.data.permissions).toContain('billing:manage');
    expect(response.body.data.scopes['lead:read']).toBe('organization');
  });

  it('rejects a malformed or forged token', async () => {
    for (const token of ['not-a-jwt', 'a.b.c', '']) {
      const response = await call<EnvelopeBody<never>>(ctx.app, {
        method: 'GET',
        url: '/api/v1/auth/me',
        token,
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rejects a token whose session has been revoked, without waiting for expiry', async () => {
    const registered = await register('revoked');
    const accessToken = registered.body.data.tokens.accessToken;

    const before = await call(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: accessToken,
    });
    expect(before.statusCode).toBe(200);

    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('revoked') } });
    await ctx.db.session.updateMany({
      where: { userId: user.id },
      data: { revokedAt: new Date(), revokedReason: 'test' },
    });

    // Checking the session on every request is what makes revocation immediate.
    const after = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: accessToken,
    });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a token that claims a session belonging to someone else', async () => {
    const other = await register('victim');
    const otherSessionId = (
      await ctx.db.session.findFirstOrThrow({
        where: { user: { email: email('victim') } },
        orderBy: { createdAt: 'desc' },
      })
    ).id;

    const attackerUser = await ctx.db.user.findUniqueOrThrow({
      where: { email: email('session') },
    });
    const tokenService = new TokenService({
      JWT_ACCESS_SECRET: process.env['JWT_ACCESS_SECRET']!,
      JWT_REFRESH_SECRET: process.env['JWT_REFRESH_SECRET']!,
      ACCESS_TOKEN_TTL: '15m',
      REFRESH_TOKEN_TTL: '30d',
    } as never);

    // A validly-signed token pairing one user's id with another user's session id.
    const forged = await tokenService.signAccessToken({
      userId: attackerUser.id,
      organizationId: other.body.data.activeOrganizationId,
      sessionId: otherSessionId,
    });

    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: forged,
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists sessions and marks the current one', async () => {
    const response = await call<EnvelopeBody<{ id: string; current: boolean }[]>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/sessions',
      token: tokens.accessToken,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.filter((session) => session.current)).toHaveLength(1);
  });

  it('will not let one user revoke another user’s session', async () => {
    const victimSession = await ctx.db.session.findFirstOrThrow({
      where: { user: { email: email('victim') } },
    });
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${victimSession.id}`,
      token: tokens.accessToken,
    });
    // 404 rather than 403: the API does not confirm that someone else's session exists.
    expect(response.statusCode).toBe(404);

    const stillLive = await ctx.db.session.findUniqueOrThrow({ where: { id: victimSession.id } });
    expect(stillLive.revokedAt).toBeNull();
  });

  it('signs out everywhere', async () => {
    const registered = await register('logoutall');
    const accessToken = registered.body.data.tokens.accessToken;

    const response = await call<EnvelopeBody<{ revokedSessions: number }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      payload: {},
      token: accessToken,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.data.revokedSessions).toBeGreaterThan(0);

    const after = await call(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: accessToken,
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('tenant isolation of the authenticated context', () => {
  it('scopes each caller to their own organization, under concurrency', async () => {
    const [a, b] = await Promise.all([register('tenantA'), register('tenantB')]);
    const tokenA = a.body.data.tokens.accessToken;
    const tokenB = b.body.data.tokens.accessToken;

    // Interleaved requests must never observe each other's tenant context: this is the
    // property `tenantContext.enterWith` in the guard has to preserve.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        call<EnvelopeBody<{ activeOrganizationId: string }>>(ctx.app, {
          method: 'GET',
          url: '/api/v1/auth/me',
          token: index % 2 === 0 ? tokenA : tokenB,
        }),
      ),
    );

    for (const [index, result] of results.entries()) {
      const expected =
        index % 2 === 0 ? a.body.data.activeOrganizationId : b.body.data.activeOrganizationId;
      expect(result.body.data.activeOrganizationId).toBe(expected);
    }
  });

  it('refuses to switch into an organization the user is not a member of', async () => {
    const [a, b] = await Promise.all([register('switchA'), register('switchB')]);

    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/switch-org',
      payload: { organizationId: b.body.data.activeOrganizationId },
      token: a.body.data.tokens.accessToken,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses access to a suspended organization, without destroying anything', async () => {
    const registered = await register('suspended');
    const organizationId = registered.body.data.activeOrganizationId;

    await ctx.db.organization.update({
      where: { id: organizationId },
      data: { status: 'suspended', suspendedAt: new Date() },
    });

    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: registered.body.data.tokens.accessToken,
    });
    expect(response.statusCode).toBe(403);
    expect(response.body.error?.code).toBe('ORG_SUSPENDED');

    // Data is preserved: suspension gates access, it does not delete (FR-TEN-6).
    const stillThere = await ctx.db.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(stillThere.deletedAt).toBeNull();
  });
});

describe('email verification', () => {
  it('confirms the address with the emailed token', async () => {
    await register('verify');
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('verify') } });
    expect(user.emailVerifiedAt).toBeNull();

    // The plaintext token only exists in the email, so the test recreates one the same way
    // the service does: issue a fresh record with a known token.
    const token = newToken(32);
    await ctx.db.emailVerification.create({
      data: {
        id: newId(),
        userId: user.id,
        email: user.email,
        tokenHash: TokenService.hashToken(token),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const response = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token },
    });
    expect(response.statusCode).toBe(200);

    const verified = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(verified.emailVerifiedAt).not.toBeNull();
  });

  it('rejects an expired token', async () => {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('verify') } });
    const token = newToken(32);
    await ctx.db.emailVerification.create({
      data: {
        id: newId(),
        userId: user.id,
        email: user.email,
        tokenHash: TokenService.hashToken(token),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token },
    });
    expect(response.statusCode).toBe(400);
  });

  it('does not reveal whether an address is registered when resending', async () => {
    const known = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      payload: { email: email('verify') },
    });
    const unknown = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      payload: { email: `ghost.${EMAIL_MARKER}@test.local` },
    });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body.message).toBe(unknown.body.message);
  });
});

describe('password reset', () => {
  it('does not reveal whether an address is registered', async () => {
    await register('reset');
    const known = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: email('reset') },
    });
    const unknown = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: `nobody2.${EMAIL_MARKER}@test.local` },
    });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body.message).toBe(unknown.body.message);
  });

  it('issues a single-use token, and only the newest one works', async () => {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('reset') } });

    await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: email('reset') },
    });
    const outstanding = await ctx.db.passwordReset.count({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(outstanding).toBe(1);
  });

  it('resets the password, revokes every session, and enforces the policy', async () => {
    const registered = await register('resetflow');
    const oldAccessToken = registered.body.data.tokens.accessToken;
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('resetflow') } });

    const token = newToken(32);
    await ctx.db.passwordReset.create({
      data: {
        id: newId(),
        userId: user.id,
        tokenHash: TokenService.hashToken(token),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const weak = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'password123' },
    });
    expect(weak.statusCode).toBe(400);

    const newPassword = 'a brighter copper teapot';
    const reset = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: newPassword },
    });
    expect(reset.statusCode).toBe(200);

    // Existing sessions must not survive a reset — the reset may be the response to a theft.
    const afterReset = await call(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: oldAccessToken,
    });
    expect(afterReset.statusCode).toBe(401);

    const signIn = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('resetflow'), password: newPassword },
    });
    expect(signIn.statusCode).toBe(200);

    const reused = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'yet another passphrase here' },
    });
    expect(reused.statusCode).toBe(400);
  });
});
