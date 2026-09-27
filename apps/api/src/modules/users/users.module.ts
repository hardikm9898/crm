import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { InvitationMailProcessor } from './processors/invitation-mail.processor.js';

/**
 * Members and invitations. Role management, user disabling and profile editing arrive in
 * Phase 1 step 5.
 */
@Module({
  imports: [AuthModule],
  controllers: [MembersController],
  providers: [MembersService, InvitationMailProcessor],
  exports: [MembersService, InvitationMailProcessor],
})
export class UsersModule {}
