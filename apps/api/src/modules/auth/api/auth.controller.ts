import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, withPlatformScope } from '@leados/shared';
import { Res, Req } from '@nestjs/common';
import { APP_CONFIG } from '../../../infra/config/config.module.js';
import type { AppConfig } from '../../../infra/config/config.schema.js';
import { zodBody } from '../../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../../infra/http/envelope.interceptor.js';
import { DbService } from '../../../infra/db/db.service.js';
import { AuthService, type AuthTokens, type LoginResult } from '../application/auth.service.js';
import { CredentialRecoveryService } from '../application/credential-recovery.service.js';
import { MfaService } from '../application/mfa.service.js';
import { PasswordService } from '../application/password.service.js';
import { SessionService } from '../application/session.service.js';
import { Public } from '../guards/public.decorator.js';
import { NoPermissionRequired } from '../../../infra/authz/permission.decorator.js';
import {
  CurrentSession,
  CurrentUser,
  type AuthenticatedUser,
} from '../guards/current-user.decorator.js';
import {
  acceptInvitationSchema,
  loginSchema,
  mfaConfirmSchema,
  mfaDisableSchema,
  mfaLoginSchema,
  refreshSchema,
  registerSchema,
  requestPasswordResetSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  switchOrganizationSchema,
  verifyEmailSchema,
} from './auth.dto.js';

/**
 * Authentication endpoints (docs/api-architecture.md §5, "Auth & session").
 *
 * Browser clients get the refresh token in an httpOnly cookie — it is never readable by
 * JavaScript, which is what limits the damage of an XSS bug. Non-browser clients read it
 * from the response body. The cookie is `SameSite=Lax` and refresh additionally requires a
 * custom header, so it cannot be driven by a cross-site form post (docs/security.md §6).
 */
const REFRESH_COOKIE = 'leados_rt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly recovery: CredentialRecoveryService,
    private readonly mfa: MfaService,
    private readonly passwords: PasswordService,
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── Registration and sign-in ──────────────────────────────────────────────

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(
    @Body(zodBody(registerSchema)) body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = body as Parameters<AuthService['register']>[0];
    const result = await this.auth.register(input);
    this.setRefreshCookie(reply, result.tokens.refreshToken);
    return withMessage(
      {
        user: result.user,
        organization: { id: result.activeOrganizationId, slug: result.organizationSlug },
        activeOrganizationId: result.activeOrganizationId,
        tokens: this.publicTokens(result.tokens),
        emailVerificationRequired: true,
      },
      'Your workspace is ready. Check your email to confirm your address.',
    );
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zodBody(loginSchema)) body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = body as { email: string; password: string };
    const result = await this.auth.login(input);
    return this.respondToLogin(result, reply);
  }

  @Public()
  @Post('mfa/verify-login')
  @HttpCode(200)
  async verifyMfaLogin(
    @Body(zodBody(mfaLoginSchema)) body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = body as { challengeToken: string; code: string };
    const result = await this.auth.completeMfaLogin(input);
    return this.respondToLogin(result, reply);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(zodBody(refreshSchema)) body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const supplied = (body as { refreshToken?: string }).refreshToken;
    const token = supplied ?? readCookie(request, REFRESH_COOKIE);
    if (!token) throw new AppError('UNAUTHENTICATED', 'No refresh token supplied', 401);

    const tokens = await this.auth.refresh(token);
    this.setRefreshCookie(reply, tokens.refreshToken);
    return { tokens: this.publicTokens(tokens) };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Body(zodBody(refreshSchema)) body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token =
      (body as { refreshToken?: string }).refreshToken ?? readCookie(request, REFRESH_COOKIE);
    if (token) await this.auth.logout(token);
    this.clearRefreshCookie(reply);
    // Always reports success: whether the token was already invalid is not the client's
    // problem, and the outcome is identical.
    return withMessage({ signedOut: true }, 'Signed out');
  }

  @NoPermissionRequired('own session')
  @Post('logout-all')
  @HttpCode(200)
  async logoutEverywhere(
    @CurrentSession() session: { userId: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const revoked = await this.auth.logoutEverywhere(session.userId);
    this.clearRefreshCookie(reply);
    return withMessage({ revokedSessions: revoked }, 'Signed out on all devices');
  }

  // ── Session and identity ──────────────────────────────────────────────────

  @NoPermissionRequired('describes the caller')
  @Get('me')
  async me() {
    return this.auth.describeCurrentUser();
  }

  @NoPermissionRequired('own sessions')
  @Get('sessions')
  async listSessions(@CurrentSession() current: { userId: string; sessionId: string }) {
    const sessions = await this.sessions.listForUser(current.userId);
    return {
      items: sessions.map((session) => ({
        id: session.id,
        current: session.id === current.sessionId,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
      })),
      pagination: {
        limit: sessions.length,
        nextCursor: null,
        hasMore: false,
        total: sessions.length,
      },
    };
  }

  @NoPermissionRequired('own sessions')
  @Delete('sessions/:id')
  @HttpCode(200)
  async revokeSession(@Param('id') id: string, @CurrentSession() current: { userId: string }) {
    // Scoped to the caller's own sessions: the id alone must not be enough to end
    // somebody else's session.
    const owned = await withPlatformScope('auth: verify session ownership', async () =>
      this.db.client.session.findFirst({ where: { id, userId: current.userId } }),
    );
    if (!owned) throw AppError.notFound('Session');

    await this.sessions.revoke(id, 'revoked_by_user');
    return withMessage({ revoked: true }, 'Session ended');
  }

  @NoPermissionRequired('own session; membership is verified in the service')
  @Post('switch-org')
  @HttpCode(200)
  async switchOrganization(
    @Body(zodBody(switchOrganizationSchema)) body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { organizationId } = body as { organizationId: string };
    const tokens = await this.auth.switchOrganization({
      userId: user.userId,
      sessionId: user.sessionId,
      organizationId,
    });
    return {
      tokens: {
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        tokenType: tokens.tokenType,
      },
      activeOrganizationId: organizationId,
    };
  }

  // ── Email verification ────────────────────────────────────────────────────

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body(zodBody(verifyEmailSchema)) body: unknown) {
    const { token } = body as { token: string };
    const result = await this.recovery.verifyEmail(token);
    return withMessage({ email: result.email }, 'Email address confirmed');
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(202)
  async resendVerification(@Body(zodBody(resendVerificationSchema)) body: unknown) {
    const { email } = body as { email: string };
    const user = await withPlatformScope('auth: resend verification', async () =>
      this.db.client.user.findUnique({ where: { email } }),
    );
    if (user && user.emailVerifiedAt === null && user.deletedAt === null) {
      await this.recovery.sendVerificationEmail(user.id, user.email);
    }
    // Same response either way: this endpoint must not confirm whether an address is registered.
    return withMessage(
      { sent: true },
      'If that address needs confirming, we have sent a new link.',
    );
  }

  // ── Password reset ────────────────────────────────────────────────────────

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body(zodBody(requestPasswordResetSchema)) body: unknown) {
    const { email } = body as { email: string };
    await this.recovery.requestPasswordReset(email);
    return withMessage(
      { sent: true },
      'If an account exists for that address, a reset link is on its way.',
    );
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(
    @Body(zodBody(resetPasswordSchema)) body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { token, password } = body as { token: string; password: string };
    await this.recovery.resetPassword(token, password);
    this.clearRefreshCookie(reply);
    return withMessage(
      { reset: true },
      'Password updated. You have been signed out everywhere — please sign in again.',
    );
  }

  // ── Multi-factor authentication ───────────────────────────────────────────

  @NoPermissionRequired('own credentials')
  @Post('mfa/setup')
  @HttpCode(200)
  async setupMfa(@CurrentSession() current: { userId: string }) {
    const user = await withPlatformScope('auth: load user for mfa setup', async () =>
      this.db.client.user.findUniqueOrThrow({ where: { id: current.userId } }),
    );
    const enrolment = await this.mfa.beginEnrolment(user.id, user.email);
    return withMessage(
      { secret: enrolment.secret, otpauthUrl: enrolment.otpauthUrl },
      'Scan the code in your authenticator app, then confirm with a code.',
    );
  }

  @NoPermissionRequired('own credentials')
  @Post('mfa/confirm')
  @HttpCode(200)
  async confirmMfa(
    @Body(zodBody(mfaConfirmSchema)) body: unknown,
    @CurrentSession() current: { userId: string },
  ) {
    const { code } = body as { code: string };
    const user = await withPlatformScope('auth: load user for mfa confirm', async () =>
      this.db.client.user.findUniqueOrThrow({ where: { id: current.userId } }),
    );
    const recoveryCodes = await this.mfa.confirmEnrolment(user.id, user.email, code);
    return withMessage(
      { enabled: true, recoveryCodes },
      'Two-factor authentication is on. Save these recovery codes — they are shown only once.',
    );
  }

  @NoPermissionRequired('own credentials')
  @Post('mfa/disable')
  @HttpCode(200)
  async disableMfa(
    @Body(zodBody(mfaDisableSchema)) body: unknown,
    @CurrentSession() current: { userId: string },
  ) {
    const { password } = body as { password: string };
    const user = await withPlatformScope('auth: load user for mfa disable', async () =>
      this.db.client.user.findUniqueOrThrow({ where: { id: current.userId } }),
    );
    // Re-authentication before weakening account security: a hijacked session must not be
    // able to switch off the second factor.
    const { valid } = await this.passwords.verify(user.passwordHash ?? '', password);
    if (!valid) throw new AppError('UNAUTHENTICATED', 'Password is incorrect', 401);

    await this.mfa.disable(user.id);
    return withMessage({ enabled: false }, 'Two-factor authentication is off');
  }

  @NoPermissionRequired('own credentials')
  @Get('mfa/recovery-codes/count')
  async countRecoveryCodes(@CurrentSession() current: { userId: string }) {
    return { remaining: await this.mfa.countUnusedRecoveryCodes(current.userId) };
  }

  // ── Invitations ───────────────────────────────────────────────────────────

  @Public()
  @Post('invitations/accept')
  @HttpCode(200)
  async acceptInvitation(
    @Body(zodBody(acceptInvitationSchema)) body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = body as { token: string; name?: string; password?: string };
    const result = await this.auth.acceptInvitation(input);
    this.setRefreshCookie(reply, result.tokens.refreshToken);
    return withMessage(
      {
        user: result.user,
        tokens: this.publicTokens(result.tokens),
        activeOrganizationId: result.activeOrganizationId,
      },
      'Welcome aboard',
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private respondToLogin(result: LoginResult, reply: FastifyReply) {
    if (result.status === 'mfa_required') {
      return withMessage(
        { mfaRequired: true, challengeToken: result.challengeToken },
        'Enter the code from your authenticator app',
      );
    }
    this.setRefreshCookie(reply, result.tokens.refreshToken);
    return withMessage(
      {
        user: result.user,
        tokens: this.publicTokens(result.tokens),
        activeOrganizationId: result.activeOrganizationId,
      },
      'Signed in',
    );
  }

  private publicTokens(tokens: AuthTokens) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: tokens.tokenType,
    };
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    if (!token) return;
    reply.header(
      'set-cookie',
      serializeCookie(REFRESH_COOKIE, token, {
        httpOnly: true,
        secure: this.config.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/api/v1/auth',
        maxAgeSeconds: 30 * 86_400,
      }),
    );
  }

  private clearRefreshCookie(reply: FastifyReply): void {
    reply.header(
      'set-cookie',
      serializeCookie(REFRESH_COOKIE, '', {
        httpOnly: true,
        secure: this.config.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/api/v1/auth',
        maxAgeSeconds: 0,
      }),
    );
  }
}

/**
 * Minimal cookie handling, rather than adding a plugin for two cookies. Values are
 * base64url refresh tokens, so no escaping beyond encodeURIComponent is required.
 */
function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Lax' | 'Strict' | 'None';
    path: string;
    maxAgeSeconds: number;
  },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return null;
}
