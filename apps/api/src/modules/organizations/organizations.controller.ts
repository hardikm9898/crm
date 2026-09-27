import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { AllowWhenRestricted } from '../../infra/entitlements/subscription.guard.js';
import { zodBody } from '../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { OrganizationsService } from './organizations.service.js';
import {
  createBranchSchema,
  createTeamSchema,
  teamMemberSchema,
  updateBranchSchema,
  updateOnboardingSchema,
  updateOrganizationSchema,
  updateTeamSchema,
} from './organizations.dto.js';

@Controller()
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  // ── Organization ──────────────────────────────────────────────────────────

  @Get('organization')
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async get() {
    return this.organizations.get();
  }

  @Patch('organization')
  @RequirePermission(PERMISSIONS.ORGANIZATION_MANAGE)
  async update(@Body(zodBody(updateOrganizationSchema)) body: unknown) {
    const updated = await this.organizations.update(
      body as Parameters<OrganizationsService['update']>[0],
    );
    return withMessage(updated, 'Settings saved');
  }

  /**
   * Onboarding stays available in restricted mode: a tenant whose trial lapsed mid-setup must be
   * able to finish choosing a plan, and blocking the wizard would trap them.
   */
  @Patch('organization/onboarding')
  @RequirePermission(PERMISSIONS.ORGANIZATION_MANAGE)
  @AllowWhenRestricted()
  async updateOnboarding(@Body(zodBody(updateOnboardingSchema)) body: unknown) {
    const state = await this.organizations.updateOnboarding(
      body as Parameters<OrganizationsService['updateOnboarding']>[0],
    );
    return { onboarding: state };
  }

  // ── Branches ──────────────────────────────────────────────────────────────

  @Get('branches')
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async listBranches() {
    return this.organizations.listBranches();
  }

  @Post('branches')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.BRANCH_MANAGE)
  async createBranch(@Body(zodBody(createBranchSchema)) body: unknown) {
    const branch = await this.organizations.createBranch(
      body as Parameters<OrganizationsService['createBranch']>[0],
    );
    return withMessage(branch, 'Branch created');
  }

  @Patch('branches/:id')
  @RequirePermission(PERMISSIONS.BRANCH_MANAGE)
  async updateBranch(@Param('id') id: string, @Body(zodBody(updateBranchSchema)) body: unknown) {
    return withMessage(
      await this.organizations.updateBranch(
        id,
        body as Parameters<OrganizationsService['updateBranch']>[1],
      ),
      'Branch updated',
    );
  }

  @Delete('branches/:id')
  @RequirePermission(PERMISSIONS.BRANCH_MANAGE)
  async deleteBranch(@Param('id') id: string) {
    return withMessage(await this.organizations.deleteBranch(id), 'Branch deleted');
  }

  // ── Teams ─────────────────────────────────────────────────────────────────

  @Get('teams')
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async listTeams() {
    return this.organizations.listTeams();
  }

  @Post('teams')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.TEAM_MANAGE)
  async createTeam(@Body(zodBody(createTeamSchema)) body: unknown) {
    return withMessage(
      await this.organizations.createTeam(
        body as Parameters<OrganizationsService['createTeam']>[0],
      ),
      'Team created',
    );
  }

  @Patch('teams/:id')
  @RequirePermission(PERMISSIONS.TEAM_MANAGE)
  async updateTeam(@Param('id') id: string, @Body(zodBody(updateTeamSchema)) body: unknown) {
    return withMessage(
      await this.organizations.updateTeam(
        id,
        body as Parameters<OrganizationsService['updateTeam']>[1],
      ),
      'Team updated',
    );
  }

  @Delete('teams/:id')
  @RequirePermission(PERMISSIONS.TEAM_MANAGE)
  async deleteTeam(@Param('id') id: string) {
    return withMessage(await this.organizations.deleteTeam(id), 'Team deleted');
  }

  @Post('teams/:id/members')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.TEAM_MANAGE)
  async addTeamMember(@Param('id') id: string, @Body(zodBody(teamMemberSchema)) body: unknown) {
    return withMessage(
      await this.organizations.addTeamMember(
        id,
        body as Parameters<OrganizationsService['addTeamMember']>[1],
      ),
      'Added to team',
    );
  }

  @Delete('teams/:id/members/:userId')
  @RequirePermission(PERMISSIONS.TEAM_MANAGE)
  async removeTeamMember(@Param('id') id: string, @Param('userId') userId: string) {
    return withMessage(await this.organizations.removeTeamMember(id, userId), 'Removed from team');
  }
}
