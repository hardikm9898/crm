import { Injectable } from '@nestjs/common';
import { AppError, newId, tenantContext, withPlatformScope } from '@leados/shared';
import { DbService } from '../../../infra/db/db.service.js';
import { AuditService } from '../../../infra/audit/audit.service.js';
import { OutboxService } from '../../../infra/outbox/outbox.service.js';
import { OrganizationProvisioningService } from '../../organizations/organization-provisioning.service.js';
import { CredentialRecoveryService } from './credential-recovery.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { PrincipalService, assertOrganizationUsable } from './principal.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

/**
 * Orchestrates the authentication flows. Individual concerns (hashing, tokens, sessions,
 * MFA, throttling) live in their own services; this one sequences them and owns the
 * decisions about what a caller is told.
 *
 * The rule behind most of those decisions: **an unauthenticated endpoint must not reveal
 * whether an account exists.** Wrong password, unknown email and disabled account all
 * produce the same response and the same timing cost.
 */

export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly tokenType: 'Bearer';
}

export interface LoginSuccess {
  readonly status: 'authenticated';
  readonly tokens: AuthTokens;
  readonly user: { id: string; email: string; name: string; emailVerified: boolean };
  readonly activeOrganizationId: string | null;
}

export interface MfaRequired {
  readonly status: 'mfa_required';
  readonly challengeToken: string;
}

export type LoginResult = LoginSuccess | MfaRequired;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottleService,
    private readonly mfa: MfaService,
    private readonly principals: PrincipalService,
    private readonly recovery: CredentialRecoveryService,
    private readonly provisioning: OrganizationProvisioningService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ── Registration ──────────────────────────────────────────────────────────

  async register(input: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
    industry?: string;
    timezone?: string;
    country?: string;
  }): Promise<LoginSuccess & { organizationSlug: string; emailVerificationRequired: true }> {
    const email = normalizeEmail(input.email);
    this.passwords.assertAcceptable(input.password, { email, name: input.name });

    const existing = await withPlatformScope('signup: check email', async () =>
      this.db.client.user.findUnique({ where: { email }, select: { id: true } }),
    );
    if (existing) {
      // Registration is the one place where silence is worse than disclosure: the person
      // is in front of us and needs to know to sign in instead. Password reset is the
      // enumeration-sensitive flow, and that one stays silent.
      throw AppError.conflict('An account already exists for this email address. Try signing in.');
    }

    const passwordHash = await this.passwords.hash(input.password);
    const userId = newId();

    await withPlatformScope('signup: create user', async () => {
      await this.db.client.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            email,
            name: input.name.trim(),
            passwordHash,
            status: 'active',
            timezone: input.timezone ?? 'Asia/Kolkata',
          },
        });
        await this.outbox.emit(
          tx,
          [
            {
              name: 'user.registered',
              aggregateType: 'user',
              aggregateId: userId,
              payload: { userId, email },
            },
          ],
          { organizationId: null },
        );
      });
    });

    const organization = await this.provisioning.provision({
      organizationName: input.organizationName,
      ownerUserId: userId,
      industry: input.industry,
      timezone: input.timezone,
      country: input.country,
    });

    await this.recovery.requestEmailVerification(userId, email);

    const session = await this.sessions.issue({
      userId,
      activeOrganizationId: organization.organizationId,
    });
    const accessToken = await this.tokens.signAccessToken({
      userId,
      organizationId: organization.organizationId,
      sessionId: session.sessionId,
    });

    return {
      status: 'authenticated',
      tokens: this.tokenResponse(accessToken, session.refreshToken),
      user: { id: userId, email, name: input.name.trim(), emailVerified: false },
      activeOrganizationId: organization.organizationId,
      organizationSlug: organization.slug,
      emailVerificationRequired: true,
    };
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(input: { email: string; password: string }): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    await this.throttle.assertAllowed(email);

    const user = await withPlatformScope('auth: find user for login', async () =>
      this.db.client.user.findUnique({ where: { email } }),
    );

    // Hash even when the user does not exist, so response time does not distinguish
    // "no such account" from "wrong password".
    const storedHash = user?.passwordHash ?? DUMMY_HASH;
    const { valid, needsRehash } = await this.passwords.verify(storedHash, input.password);

    const usable = user !== null && user.deletedAt === null && user.status !== 'disabled';
    if (!valid || !usable) {
      await this.throttle.recordFailure(email);
      if (user) {
        await this.audit.record({
          organizationId: await this.anyOrganizationFor(user.id),
          actorType: 'user',
          actorId: user.id,
          action: 'auth.login_failed',
          resourceType: 'user',
          resourceId: user.id,
          after: { reason: valid ? 'account_not_usable' : 'bad_password' },
        });
      }
      throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect', 401);
    }

    await this.throttle.recordSuccess(email);

    if (needsRehash) {
      // Transparent upgrade to current hashing parameters, on the one occasion we hold
      // the plaintext legitimately.
      const upgraded = await this.passwords.hash(input.password);
      await withPlatformScope('auth: upgrade password hash', async () => {
        await this.db.client.user.update({
          where: { id: user.id },
          data: { passwordHash: upgraded },
        });
      });
    }

    if (user.mfaEnabled) {
      return {
        status: 'mfa_required',
        challengeToken: await this.tokens.signMfaChallenge(user.id),
      };
    }

    return this.completeLogin(user.id, user.email, user.name, user.emailVerifiedAt !== null);
  }

  /** Second step of login for accounts with MFA enabled. */
  async completeMfaLogin(input: { challengeToken: string; code: string }): Promise<LoginSuccess> {
    const claims = await this.tokens.verifyMfaChallenge(input.challengeToken);
    const userId = claims.sub;

    const user = await withPlatformScope('auth: load user for mfa', async () =>
      this.db.client.user.findUnique({ where: { id: userId } }),
    );
    if (!user || user.deletedAt !== null || user.status === 'disabled') {
      throw new AppError('UNAUTHENTICATED', 'Sign-in could not be completed', 401);
    }

    await this.throttle.assertAllowed(`mfa:${userId}`);
    try {
      const result = await this.mfa.verifyChallenge(userId, user.email, input.code);
      await this.throttle.recordSuccess(`mfa:${userId}`);

      if (result.method === 'recovery_code') {
        await this.audit.record({
          organizationId: await this.anyOrganizationFor(userId),
          actorType: 'user',
          actorId: userId,
          action: 'auth.mfa_recovery_code_used',
          resourceType: 'user',
          resourceId: userId,
          after: { remainingRecoveryCodes: result.remainingRecoveryCodes ?? 0 },
        });
      }
    } catch (error) {
      await this.throttle.recordFailure(`mfa:${userId}`);
      throw error;
    }

    return this.completeLogin(user.id, user.email, user.name, user.emailVerifiedAt !== null);
  }

  private async completeLogin(
    userId: string,
    email: string,
    name: string,
    emailVerified: boolean,
  ): Promise<LoginSuccess> {
    const activeOrganizationId = await this.defaultOrganizationFor(userId);

    const session = await this.sessions.issue({ userId, activeOrganizationId });
    const accessToken = await this.tokens.signAccessToken({
      userId,
      organizationId: activeOrganizationId,
      sessionId: session.sessionId,
    });

    await withPlatformScope('auth: record login', async () => {
      await this.db.client.user.update({
        where: { id: userId },
        data: { lastLoginAt: new Date() },
      });
    });

    if (activeOrganizationId) {
      await this.audit.record({
        organizationId: activeOrganizationId,
        actorType: 'user',
        actorId: userId,
        action: 'auth.login_succeeded',
        resourceType: 'user',
        resourceId: userId,
      });
    }

    return {
      status: 'authenticated',
      tokens: this.tokenResponse(accessToken, session.refreshToken),
      user: { id: userId, email, name, emailVerified },
      activeOrganizationId,
    };
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const rotated = await this.sessions.rotate(refreshToken);
    const accessToken = await this.tokens.signAccessToken({
      userId: rotated.userId,
      organizationId: rotated.activeOrganizationId,
      sessionId: rotated.session.sessionId,
    });
    return this.tokenResponse(accessToken, rotated.session.refreshToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.sessions.revokeByRefreshToken(refreshToken, 'logout');
  }

  async logoutEverywhere(userId: string): Promise<number> {
    return this.sessions.revokeAllForUser(userId, 'logout_all');
  }

  /** Switching organization re-points the session; the next access token carries the new org. */
  async switchOrganization(input: {
    userId: string;
    sessionId: string;
    organizationId: string;
  }): Promise<AuthTokens> {
    const membership = await withPlatformScope('auth: verify membership for switch', async () =>
      this.db.client.membership.findUnique({
        where: {
          organizationId_userId: { organizationId: input.organizationId, userId: input.userId },
        },
        include: { organization: { select: { status: true, deletedAt: true } } },
      }),
    );
    if (!membership || membership.deletedAt !== null || membership.status !== 'active') {
      throw AppError.notFound('Organization');
    }
    if (membership.organization.deletedAt !== null) throw AppError.notFound('Organization');
    assertOrganizationUsable(membership.organization.status);

    await this.sessions.setActiveOrganization(input.sessionId, input.organizationId);
    const accessToken = await this.tokens.signAccessToken({
      userId: input.userId,
      organizationId: input.organizationId,
      sessionId: input.sessionId,
    });

    // The refresh token is unchanged: switching organization is not a new login.
    return {
      accessToken,
      refreshToken: '',
      expiresIn: this.tokens.accessTtlSeconds,
      tokenType: 'Bearer',
    };
  }

  // ── Invitations ───────────────────────────────────────────────────────────

  /**
   * Accepting an invitation creates the account if needed, joins the organization and
   * applies the role the inviter chose (FR-IAM-7).
   */
  async acceptInvitation(input: {
    token: string;
    name?: string;
    password?: string;
  }): Promise<LoginSuccess> {
    const tokenHash = TokenService.hashToken(input.token);

    const invitation = await withPlatformScope('auth: load invitation', async () =>
      this.db.client.invitation.findUnique({ where: { tokenHash } }),
    );
    if (
      !invitation ||
      invitation.status !== 'pending' ||
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This invitation is invalid, already used, or has expired.',
        400,
      );
    }

    const email = normalizeEmail(invitation.email);
    const existingUser = await withPlatformScope('auth: find invited user', async () =>
      this.db.client.user.findUnique({ where: { email } }),
    );

    if (!existingUser && (!input.password || !input.name)) {
      throw AppError.validation('A name and password are required to create your account', [
        { field: 'password', code: 'REQUIRED', message: 'Choose a password to finish signing up.' },
      ]);
    }
    if (!existingUser && input.password) {
      this.passwords.assertAcceptable(input.password, { email, name: input.name });
    }

    const userId = existingUser?.id ?? newId();
    const passwordHash =
      !existingUser && input.password ? await this.passwords.hash(input.password) : null;
    const now = new Date();

    await withPlatformScope('auth: accept invitation', async () => {
      await this.db.client.$transaction(async (tx) => {
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, status: 'pending' },
          data: { status: 'accepted', acceptedAt: now },
        });
        if (claimed.count === 0) {
          throw AppError.conflict('This invitation has already been accepted');
        }

        if (!existingUser) {
          await tx.user.create({
            data: {
              id: userId,
              email,
              name: (input.name ?? email).trim(),
              passwordHash,
              status: 'active',
              // Holding the invitation token proves control of the mailbox.
              emailVerifiedAt: now,
            },
          });
        }

        await tx.membership.create({
          data: {
            id: newId(),
            organizationId: invitation.organizationId,
            userId,
            status: 'active',
            defaultBranchId: invitation.branchId,
            joinedAt: now,
          },
        });
        await tx.userRole.create({
          data: {
            id: newId(),
            organizationId: invitation.organizationId,
            userId,
            roleId: invitation.roleId,
          },
        });
        if (invitation.teamId) {
          await tx.teamMember.create({
            data: {
              id: newId(),
              organizationId: invitation.organizationId,
              teamId: invitation.teamId,
              userId,
            },
          });
        }

        await this.audit.recordInTransaction(tx, {
          organizationId: invitation.organizationId,
          actorType: 'user',
          actorId: userId,
          action: 'invitation.accepted',
          resourceType: 'invitation',
          resourceId: invitation.id,
          after: { email, roleId: invitation.roleId },
        });

        await this.outbox.emit(
          tx,
          [
            {
              name: 'invitation.accepted',
              aggregateType: 'membership',
              aggregateId: userId,
              payload: { organizationId: invitation.organizationId, userId, email },
            },
          ],
          { organizationId: invitation.organizationId },
        );
      });
    });

    await this.principals.invalidateOrganization(invitation.organizationId);

    const user = await withPlatformScope('auth: load user after invite', async () =>
      this.db.client.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    return this.completeLogin(userId, user.email, user.name, user.emailVerifiedAt !== null);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** The organization a session starts in: the user's only one, or their oldest. */
  private async defaultOrganizationFor(userId: string): Promise<string | null> {
    const membership = await withPlatformScope('auth: resolve default organization', async () =>
      this.db.client.membership.findFirst({
        where: {
          userId,
          status: 'active',
          deletedAt: null,
          organization: { deletedAt: null, status: { notIn: ['suspended', 'cancelled'] } },
        },
        orderBy: { createdAt: 'asc' },
        select: { organizationId: true },
      }),
    );
    return membership?.organizationId ?? null;
  }

  /** Audit rows need an organization; a login failure has no tenant context yet. */
  private async anyOrganizationFor(userId: string): Promise<string | undefined> {
    const membership = await withPlatformScope('auth: resolve organization for audit', async () =>
      this.db.client.membership.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { organizationId: true },
      }),
    );
    return membership?.organizationId;
  }

  private tokenResponse(accessToken: string, refreshToken: string): AuthTokens {
    return {
      accessToken,
      refreshToken,
      expiresIn: this.tokens.accessTtlSeconds,
      tokenType: 'Bearer',
    };
  }

  /** Details for `/auth/me`: identity, organizations, and the active grant set. */
  async describeCurrentUser(): Promise<{
    user: { id: string; email: string; name: string; emailVerified: boolean; mfaEnabled: boolean };
    organizations: { id: string; slug: string; name: string; status: string; isOwner: boolean }[];
    activeOrganizationId: string;
    permissions: string[];
    scopes: Record<string, string>;
  }> {
    const principal = tenantContext.require('auth.me');
    const userId = principal.actorId;
    if (!userId) throw AppError.unauthenticated();

    const [user, memberships] = await withPlatformScope('auth: describe current user', async () =>
      Promise.all([
        this.db.client.user.findUniqueOrThrow({ where: { id: userId } }),
        this.db.client.membership.findMany({
          where: { userId, status: 'active', deletedAt: null },
          include: { organization: { select: { id: true, slug: true, name: true, status: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      ]),
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerifiedAt !== null,
        mfaEnabled: user.mfaEnabled,
      },
      organizations: memberships
        .filter((membership) => membership.organization !== null)
        .map((membership) => ({
          id: membership.organization.id,
          slug: membership.organization.slug,
          name: membership.organization.name,
          status: membership.organization.status,
          isOwner: membership.isOwner,
        })),
      activeOrganizationId: principal.organizationId,
      permissions: [...principal.permissions].sort(),
      scopes: Object.fromEntries(principal.scopes),
    };
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A real Argon2id hash of a random value, used to equalise timing when the account does
 * not exist. Verifying against it always fails, but costs the same as a real check.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';
