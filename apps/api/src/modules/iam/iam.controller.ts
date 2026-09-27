import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { zodBody } from '../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { IamService } from './iam.service.js';
import {
  createRoleSchema,
  setRoleGrantsSchema,
  setUserRolesSchema,
  updateMemberSchema,
  updateRoleSchema,
} from './iam.dto.js';

@Controller()
export class IamController {
  constructor(private readonly iam: IamService) {}

  @Get('permissions')
  @RequirePermission(PERMISSIONS.ROLE_READ)
  async listPermissions() {
    return this.iam.listPermissions();
  }

  @Get('roles')
  @RequirePermission(PERMISSIONS.ROLE_READ)
  async listRoles() {
    return this.iam.listRoles();
  }

  @Post('roles')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.ROLE_MANAGE)
  async createRole(@Body(zodBody(createRoleSchema)) body: unknown) {
    return withMessage(
      await this.iam.createRole(body as Parameters<IamService['createRole']>[0]),
      'Role created',
    );
  }

  @Patch('roles/:id')
  @RequirePermission(PERMISSIONS.ROLE_MANAGE)
  async updateRole(@Param('id') id: string, @Body(zodBody(updateRoleSchema)) body: unknown) {
    return withMessage(
      await this.iam.updateRole(id, body as Parameters<IamService['updateRole']>[1]),
      'Role updated',
    );
  }

  /** PUT, not PATCH: a permissions screen submits the intended final set of grants. */
  @Put('roles/:id/permissions')
  @RequirePermission(PERMISSIONS.ROLE_MANAGE)
  async setRoleGrants(@Param('id') id: string, @Body(zodBody(setRoleGrantsSchema)) body: unknown) {
    return withMessage(
      await this.iam.setRoleGrants(id, body as Parameters<IamService['setRoleGrants']>[1]),
      'Permissions updated',
    );
  }

  @Delete('roles/:id')
  @RequirePermission(PERMISSIONS.ROLE_MANAGE)
  async deleteRole(@Param('id') id: string) {
    return withMessage(await this.iam.deleteRole(id), 'Role deleted');
  }

  @Put('users/:id/roles')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  async setUserRoles(@Param('id') id: string, @Body(zodBody(setUserRolesSchema)) body: unknown) {
    return withMessage(
      await this.iam.setUserRoles(id, body as Parameters<IamService['setUserRoles']>[1]),
      'Roles updated',
    );
  }

  @Patch('users/:id')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  async updateMember(@Param('id') id: string, @Body(zodBody(updateMemberSchema)) body: unknown) {
    return withMessage(
      await this.iam.updateMember(id, body as Parameters<IamService['updateMember']>[1]),
      'Member updated',
    );
  }
}
