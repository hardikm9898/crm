import { Module } from '@nestjs/common';
import { OrganizationProvisioningModule } from '../organizations/provisioning.module.js';
import { AuthController } from './api/auth.controller.js';
import { AuthService } from './application/auth.service.js';
import { CredentialRecoveryService } from './application/credential-recovery.service.js';
import { LoginThrottleService } from './application/login-throttle.service.js';
import { MfaService } from './application/mfa.service.js';
import { PasswordService } from './application/password.service.js';
import { PrincipalService } from './application/principal.service.js';
import { SessionService } from './application/session.service.js';
import { TokenService } from './application/token.service.js';
import {
  EmailVerificationMailProcessor,
  PasswordResetMailProcessor,
  SecurityNoticeMailProcessor,
} from './processors/credential-mail.processor.js';

/**
 * Authentication and identity. Exports the services the global `AuthGuard` needs, so the
 * guard can be registered once in the composition root instead of per controller.
 */
@Module({
  imports: [OrganizationProvisioningModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    SessionService,
    PrincipalService,
    MfaService,
    CredentialRecoveryService,
    LoginThrottleService,
    EmailVerificationMailProcessor,
    PasswordResetMailProcessor,
    SecurityNoticeMailProcessor,
  ],
  exports: [
    TokenService,
    SessionService,
    PrincipalService,
    PasswordService,
    EmailVerificationMailProcessor,
    PasswordResetMailProcessor,
    SecurityNoticeMailProcessor,
  ],
})
export class AuthModule {}
