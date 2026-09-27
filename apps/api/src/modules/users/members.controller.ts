import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { MembersService } from './members.service.js';
import { inviteMemberSchema, listMembersSchema, type ListMembersQuery } from './members.dto.js';

/**
 * Organization members and invitations.
 *
 * Every route declares the permission it needs; the boot-time route audit refuses to start
 * the process if one does not (docs/security.md §4).
 */
@Controller('users')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission(PERMISSIONS.USER_READ)
  async list(@Query(new ZodBody(listMembersSchema)) query: ListMembersQuery) {
    // Breadth is decided by the caller's grant, not by the query: an executive asking for
    // "all users" still gets only what their scope allows.
    return this.members.list(query);
  }

  @Get('seats')
  @RequirePermission(PERMISSIONS.USER_READ, { minimumScope: 'organization' })
  async seats() {
    return this.members.seatUsage();
  }

  @Get('invitations')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  async listInvitations() {
    return this.members.listInvitations();
  }

  @Post('invitations')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  async invite(@Body(zodBody(inviteMemberSchema)) body: unknown) {
    const input = body as Parameters<MembersService['invite']>[0];
    const result = await this.members.invite(input);
    return withMessage(
      { invitationId: result.invitationId, expiresAt: result.expiresAt },
      'Invitation sent',
    );
  }

  @Delete('invitations/:id')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  async revokeInvitation(@Param('id') id: string) {
    await this.members.revokeInvitation(id);
    return withMessage({ revoked: true }, 'Invitation revoked');
  }
}
