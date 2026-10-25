import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { AutomationService } from './automation.service.js';
import {
  createWorkflowSchema,
  listWorkflowsSchema,
  saveDefinitionSchema,
  updateWorkflowSchema,
  type CreateWorkflowInput,
  type ListWorkflowsQuery,
  type SaveDefinitionInput,
  type UpdateWorkflowInput,
} from './automation.dto.js';

/**
 * Automation (`FR-AUT-1`, `FR-AUT-4`, `FR-AUT-5`).
 *
 * All of it behind `automation:manage`, which has been in the catalogue since Phase 1 and is
 * already granted in every workspace the owner and admin templates created — 328 grants before a
 * line of this was written, so there is no backfill migration here. A grant migration that
 * inserts nothing and claims otherwise is worse than none.
 *
 * There is no read-only view on purpose: a workflow definition names the workspace's statuses,
 * templates and members, and somebody who may read all of that is somebody who may configure it.
 */
@Controller('automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  /**
   * The registry (`FR-AUT-1`).
   *
   * Declared before `workflows/:id` cannot clash — `catalogue` is its own segment — but it is
   * first because it is what a reader of this file should see first: everything below is CRUD
   * over something this response describes.
   */
  @Get('catalogue')
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  catalogue() {
    return this.automation.catalogue();
  }

  @Get('workflows')
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async list(@Query(new ZodBody(listWorkflowsSchema)) query: ListWorkflowsQuery) {
    return this.automation.list(query);
  }

  @Post('workflows')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async create(@Body(zodBody(createWorkflowSchema)) body: unknown) {
    return withMessage(
      await this.automation.create(body as CreateWorkflowInput),
      'Workflow created as a draft — publish it when it is ready',
    );
  }

  @Get('workflows/:id')
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async findOne(@Param('id') id: string) {
    return this.automation.findOne(id);
  }

  @Patch('workflows/:id')
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateWorkflowSchema)) body: unknown) {
    const input = body as UpdateWorkflowInput;
    return withMessage(
      await this.automation.update(id, input),
      input.killSwitch === true ? 'Stopped — nothing more will run' : 'Workflow updated',
    );
  }

  @Delete('workflows/:id')
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(await this.automation.remove(id), 'Workflow deleted');
  }

  /**
   * Saves the draft. A `PUT` because it replaces the whole graph: a workflow is edited as one
   * thing, and a `PATCH` on part of a tree is a merge nobody can predict.
   */
  @Put('workflows/:id/definition')
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async saveDefinition(@Param('id') id: string, @Body(zodBody(saveDefinitionSchema)) body: unknown) {
    const saved = await this.automation.saveDefinition(id, body as SaveDefinitionInput);
    return withMessage(
      saved,
      saved.problems.length === 0 ? 'Draft saved' : 'Draft saved — some details still need filling in',
    );
  }

  @Post('workflows/:id/publish')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async publish(@Param('id') id: string) {
    return withMessage(await this.automation.publish(id), 'Published and live');
  }

  @Get('workflows/:id/versions')
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async versions(@Param('id') id: string) {
    return this.automation.versions(id);
  }

  /** What a run pinned to, readable long after the workflow itself has moved on (`FR-AUT-5`). */
  @Get('workflows/:id/versions/:versionId')
  @RequirePermission(PERMISSIONS.AUTOMATION_MANAGE)
  async version(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.automation.version(id, versionId);
  }
}
