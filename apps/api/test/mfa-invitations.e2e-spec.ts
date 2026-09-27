import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import { newId, newToken } from '@leados/shared';
import { TokenService } from '../src/modules/auth/application/token.service.js';
import { bootTestApp, call, cleanupUsers, type EnvelopeBody, type TestApp } from './app-harness.js';

/**
 * Multi-factor authentication, invitations and sign-in throttling
 * (FR-IAM-1, FR-IAM-7, docs/security.md §2).
 */

const SUFFIX = newToken(4)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');
const EMAIL_MARKER = `e2emfa${SUFFIX}`;
const PASSWORD = 'a quiet november harbour';

let ctx: TestApp;

const email = (label: string) => `${label}.${EMAIL_MARKER}@test.local`;

interface AuthPayload {
  user: { id: string; email: string };
  tokens: { accessToken: string; refreshToken: string };
  activeOrganizationId: string;
}

async function register(label: string) {
  return call<EnvelopeBody<AuthPayload>>(ctx.app, {
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: email(label),
      password: PASSWORD,
      name: 'Test Owner',
      organizationName: `MFA Org ${label} ${SUFFIX}`,
    },
  });
}

function codeFor(secret: string): string {
  return new TOTP({
    issuer: 'Lead OS',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
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

describe('multi-factor authentication', () => {
  let accessToken: string;
  let secret: string;

  beforeAll(async () => {
    const registered = await register('mfa');
    accessToken = registered.body.data.tokens.accessToken;
  });

  it('starts enrolment without switching MFA on yet', async () => {
    const response = await call<EnvelopeBody<{ secret: string; otpauthUrl: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      payload: {},
      token: accessToken,
    });

    expect(response.statusCode).toBe(200);
    secret = response.body.data.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/); // base32
    expect(response.body.data.otpauthUrl).toContain('otpauth://totp/');

    // A mistyped setup must not lock anyone out, so MFA stays off until a code is proven.
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('mfa') } });
    expect(user.mfaEnabled).toBe(false);
    expect(user.mfaSecretEncrypted).not.toBeNull();
  });

  it('stores the shared secret encrypted, never in plaintext', async () => {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('mfa') } });
    expect(user.mfaSecretEncrypted).not.toContain(secret);
    expect(user.mfaSecretEncrypted?.startsWith('v1.1.')).toBe(true);
  });

  it('rejects a wrong code at confirmation', async () => {
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/confirm',
      payload: { code: '000000' },
      token: accessToken,
    });
    expect(response.statusCode).toBe(400);
  });

  it('enables MFA on a valid code and issues single-use recovery codes', async () => {
    const response = await call<EnvelopeBody<{ enabled: boolean; recoveryCodes: string[] }>>(
      ctx.app,
      {
        method: 'POST',
        url: '/api/v1/auth/mfa/confirm',
        payload: { code: codeFor(secret) },
        token: accessToken,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.data.enabled).toBe(true);
    expect(response.body.data.recoveryCodes).toHaveLength(10);
    expect(response.body.data.recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    // Stored hashed, like passwords.
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('mfa') } });
    const stored = await ctx.db.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(10);
    expect(stored.every((row) => row.codeHash.length === 64)).toBe(true);
  });

  it('requires the second factor at sign-in', async () => {
    const response = await call<EnvelopeBody<{ mfaRequired: boolean; challengeToken: string }>>(
      ctx.app,
      {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: email('mfa'), password: PASSWORD },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.data.mfaRequired).toBe(true);
    expect(response.body.data.challengeToken).toBeTruthy();
    // Crucially, no session tokens are issued by the first step.
    expect(response.body.data).not.toHaveProperty('tokens');
  });

  it('completes sign-in with a TOTP code', async () => {
    const first = await call<EnvelopeBody<{ challengeToken: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('mfa'), password: PASSWORD },
    });

    const second = await call<EnvelopeBody<AuthPayload>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-login',
      payload: { challengeToken: first.body.data.challengeToken, code: codeFor(secret) },
    });

    expect(second.statusCode).toBe(200);
    expect(second.body.data.tokens.accessToken).toBeTruthy();
  });

  it('rejects a wrong code, and a challenge token cannot stand in for an access token', async () => {
    const first = await call<EnvelopeBody<{ challengeToken: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('mfa'), password: PASSWORD },
    });
    const challengeToken = first.body.data.challengeToken;

    const wrongCode = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-login',
      payload: { challengeToken, code: '111111' },
    });
    expect(wrongCode.statusCode).toBe(401);

    const asAccessToken = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: challengeToken,
    });
    expect(asAccessToken.statusCode).toBe(401);
  });

  it('accepts a recovery code once, and reports how many remain', async () => {
    const registered = await register('recovery');
    const token = registered.body.data.tokens.accessToken;

    const setup = await call<EnvelopeBody<{ secret: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      payload: {},
      token,
    });
    const confirm = await call<EnvelopeBody<{ recoveryCodes: string[] }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/confirm',
      payload: { code: codeFor(setup.body.data.secret) },
      token,
    });
    const recoveryCode = confirm.body.data.recoveryCodes[0]!;

    const login = await call<EnvelopeBody<{ challengeToken: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('recovery'), password: PASSWORD },
    });
    const used = await call<EnvelopeBody<AuthPayload>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-login',
      payload: { challengeToken: login.body.data.challengeToken, code: recoveryCode },
    });
    expect(used.statusCode).toBe(200);

    const remaining = await call<EnvelopeBody<{ remaining: number }>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/mfa/recovery-codes/count',
      token: used.body.data.tokens.accessToken,
    });
    expect(remaining.body.data.remaining).toBe(9);

    // Single use: the same code must not work twice.
    const again = await call<EnvelopeBody<{ challengeToken: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('recovery'), password: PASSWORD },
    });
    const replay = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-login',
      payload: { challengeToken: again.body.data.challengeToken, code: recoveryCode },
    });
    expect(replay.statusCode).toBe(401);

    // And using a recovery code is audited — it is a break-glass event.
    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('recovery') } });
    const audit = await ctx.db.auditLog.findFirst({
      where: { actorId: user.id, action: 'auth.mfa_recovery_code_used' },
    });
    expect(audit).not.toBeNull();
  });

  it('requires the password to switch MFA off, so a hijacked session cannot weaken the account', async () => {
    const login = await call<EnvelopeBody<{ challengeToken: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('mfa'), password: PASSWORD },
    });
    const session = await call<EnvelopeBody<AuthPayload>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-login',
      payload: { challengeToken: login.body.data.challengeToken, code: codeFor(secret) },
    });
    const token = session.body.data.tokens.accessToken;

    const wrongPassword = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/disable',
      payload: { password: 'not the password' },
      token,
    });
    expect(wrongPassword.statusCode).toBe(401);

    const disabled = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/mfa/disable',
      payload: { password: PASSWORD },
      token,
    });
    expect(disabled.statusCode).toBe(200);

    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: email('mfa') } });
    expect(user.mfaEnabled).toBe(false);
    expect(user.mfaSecretEncrypted).toBeNull();
    expect(await ctx.db.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('invitations', () => {
  let organizationId: string;
  let roleId: string;
  let teamId: string;

  beforeAll(async () => {
    const registered = await register('inviter');
    organizationId = registered.body.data.activeOrganizationId;
    roleId = (
      await ctx.db.role.findFirstOrThrow({ where: { organizationId, code: 'sales_executive' } })
    ).id;
    teamId = (await ctx.db.team.findFirstOrThrow({ where: { organizationId } })).id;
  });

  async function createInvitation(invitedEmail: string, overrides: Record<string, unknown> = {}) {
    const token = newToken(32);
    await ctx.db.invitation.create({
      data: {
        id: newId(),
        organizationId,
        email: invitedEmail,
        roleId,
        teamId,
        tokenHash: TokenService.hashToken(token),
        expiresAt: new Date(Date.now() + 72 * 3_600_000),
        ...overrides,
      },
    });
    return token;
  }

  it('creates the account, membership, role and team place in one step', async () => {
    const invitedEmail = email('invited');
    const token = await createInvitation(invitedEmail);

    const response = await call<EnvelopeBody<AuthPayload>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token, name: 'Invited Executive', password: 'another good passphrase' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.data.activeOrganizationId).toBe(organizationId);

    const user = await ctx.db.user.findUniqueOrThrow({ where: { email: invitedEmail } });
    // Holding the invitation token proves mailbox control, so no separate verification.
    expect(user.emailVerifiedAt).not.toBeNull();

    const [membership, userRole, teamMember] = await Promise.all([
      ctx.db.membership.findFirstOrThrow({ where: { organizationId, userId: user.id } }),
      ctx.db.userRole.findFirstOrThrow({ where: { organizationId, userId: user.id } }),
      ctx.db.teamMember.findFirst({ where: { organizationId, userId: user.id } }),
    ]);
    expect(membership.status).toBe('active');
    expect(membership.isOwner).toBe(false);
    expect(userRole.roleId).toBe(roleId);
    expect(teamMember).not.toBeNull();
  });

  it('gives the invitee only their role’s permissions, not the owner’s', async () => {
    const invitedEmail = email('scoped');
    const token = await createInvitation(invitedEmail);
    const accepted = await call<EnvelopeBody<AuthPayload>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token, name: 'Scoped Executive', password: 'yet another passphrase' },
    });

    const me = await call<EnvelopeBody<{ permissions: string[]; scopes: Record<string, string> }>>(
      ctx.app,
      { method: 'GET', url: '/api/v1/auth/me', token: accepted.body.data.tokens.accessToken },
    );

    expect(me.body.data.permissions).toContain('lead:read');
    expect(me.body.data.permissions).not.toContain('billing:manage');
    expect(me.body.data.permissions).not.toContain('user:manage');
    // A sales executive sees their own leads, not the whole organization's.
    expect(me.body.data.scopes['lead:read']).toBe('own');
  });

  it('cannot be accepted twice', async () => {
    const invitedEmail = email('twice');
    const token = await createInvitation(invitedEmail);
    const first = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token, name: 'Once', password: 'a perfectly fine passphrase' },
    });
    expect(first.statusCode).toBe(200);

    const second = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token, name: 'Twice', password: 'a perfectly fine passphrase' },
    });
    expect(second.statusCode).toBe(400);
  });

  it('rejects an expired or revoked invitation', async () => {
    const expired = await createInvitation(email('expired'), {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const revoked = await createInvitation(email('revoked2'), {
      revokedAt: new Date(),
      status: 'revoked',
    });

    for (const token of [expired, revoked]) {
      const response = await call<EnvelopeBody<never>>(ctx.app, {
        method: 'POST',
        url: '/api/v1/auth/invitations/accept',
        payload: { token, name: 'Nope', password: 'a perfectly fine passphrase' },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('requires a password when the invitee has no account yet', async () => {
    const token = await createInvitation(email('nopassword'));
    const response = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token },
    });
    expect(response.statusCode).toBe(400);
  });

  it('adds an existing user to a second organization without a new password', async () => {
    // Multi-org membership: one identity, several workspaces (FR-IAM-6).
    const existing = await register('multiorg');
    const token = await createInvitation(email('multiorg'));

    const response = await call<EnvelopeBody<AuthPayload>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/invitations/accept',
      payload: { token },
    });
    expect(response.statusCode).toBe(200);

    const me = await call<EnvelopeBody<{ organizations: { id: string }[] }>>(ctx.app, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: response.body.data.tokens.accessToken,
    });
    expect(me.body.data.organizations).toHaveLength(2);

    // And they can switch between them.
    const target = me.body.data.organizations.find(
      (org) => org.id !== existing.body.data.activeOrganizationId,
    );
    const switched = await call<EnvelopeBody<{ activeOrganizationId: string }>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/switch-org',
      payload: { organizationId: target!.id },
      token: response.body.data.tokens.accessToken,
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.body.data.activeOrganizationId).toBe(target!.id);
  });
});

describe('sign-in throttling', () => {
  // Each test uses its own client IP: the per-IP limiter is a separate control from the
  // per-account one, and mixing them would make these tests order-dependent.
  it('locks out an account after repeated failures and says when to retry', async () => {
    await register('throttle');
    const target = email('throttle');
    const ip = '198.51.100.11';

    let lockedOut = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await call<EnvelopeBody<never>>(ctx.app, {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: target, password: `wrong-guess-${attempt}` },
        ip,
      });
      if (response.statusCode === 429) {
        expect(response.body.error?.code).toBe('RATE_LIMITED');
        expect(response.body.error?.message).toMatch(/try again in about \d+ minute/);
        lockedOut = true;
        break;
      }
      expect(response.statusCode).toBe(401);
    }
    expect(lockedOut).toBe(true);

    // The lockout holds even for the correct password: the account is cooling down, not the
    // individual guess.
    const withCorrectPassword = await call<EnvelopeBody<never>>(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: target, password: PASSWORD },
      ip,
    });
    expect(withCorrectPassword.statusCode).toBe(429);
  });

  it('clears the account counter after a successful sign-in', async () => {
    await register('throttleclear');
    const target = email('throttleclear');
    const ip = '198.51.100.22';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await call(ctx.app, {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: target, password: 'wrong' },
        ip,
      });
    }

    const success = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: target, password: PASSWORD },
      ip,
    });
    expect(success.statusCode).toBe(200);

    const again = await call(ctx.app, {
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: target, password: PASSWORD },
      ip,
    });
    expect(again.statusCode).toBe(200);
  });

  it('throttles one IP spraying many accounts, not just one account', async () => {
    // Credential stuffing looks different from password grinding: many accounts, one source.
    const ip = '198.51.100.33';
    let blocked = false;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await call<EnvelopeBody<never>>(ctx.app, {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `sprayed${attempt}.${EMAIL_MARKER}@test.local`, password: 'whatever' },
        ip,
      });
      if (response.statusCode === 429) {
        blocked = true;
        break;
      }
    }

    expect(blocked).toBe(true);
  });
});
