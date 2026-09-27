import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { z } from 'zod';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { CrmConfigService } from './crm-config.service.js';
import {
  createLostReasonSchema,
  createPipelineSchema,
  createSourceSchema,
  createStatusSchema,
  createTagSchema,
  setStagesSchema,
  updateLostReasonSchema,
  updatePipelineSchema,
  updateSourceSchema,
  updateStatusSchema,
  updateTagSchema,
} from './crm-config.dto.js';

const listQuerySchema = z
  .object({
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * The tenant's CRM vocabulary.
 *
 * **Reads are gated on `lead:read`, not `settings:read`.** Anyone who can see a lead needs the words
 * it is described in — a sales executive holds `lead:read` but not `settings:read`, and a form that
 * cannot list its own statuses is not a form. Writes need the matching management permission:
 * `pipeline:manage` for statuses, pipelines and stages (the permission's own description says so),
 * `settings:manage` for sources and lost reasons.
 *
 * Tags are the one split: creating one is part of working a lead (`lead:update`), while renaming or
 * deleting one affects every lead that carries it and needs `settings:manage`.
 */
@Controller('crm')
export class CrmConfigController {
  constructor(private readonly config: CrmConfigService) {}

  /** Everything a lead form or board needs, in one request. */
  @Get('config')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async bundle() {
    return this.config.bundle();
  }

  // ── Statuses ──────────────────────────────────────────────────────────────

  @Get('statuses')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listStatuses(@Query(new ZodBody(listQuerySchema)) query: ListQuery) {
    return this.config.listStatuses(query.includeInactive);
  }

  @Post('statuses')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.PIPELINE_MANAGE)
  async createStatus(@Body(zodBody(createStatusSchema)) body: unknown) {
    return withMessage(
      await this.config.createStatus(body as Parameters<CrmConfigService['createStatus']>[0]),
      'Status created',
    );
  }

  @Patch('statuses/:id')
  @RequirePermission(PERMISSIONS.PIPELINE_MANAGE)
  async updateStatus(@Param('id') id: string, @Body(zodBody(updateStatusSchema)) body: unknown) {
    return withMessage(
      await this.config.updateStatus(id, body as Parameters<CrmConfigService['updateStatus']>[1]),
      'Status updated',
    );
  }

  @Delete('statuses/:id')
  @RequirePermission(PERMISSIONS.PIPELINE_MANAGE)
  async deleteStatus(@Param('id') id: string) {
    return withMessage(await this.config.deleteStatus(id), 'Status deleted');
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  @Get('sources')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listSources(@Query(new ZodBody(listQuerySchema)) query: ListQuery) {
    return this.config.listSources(query.includeInactive);
  }

  @Post('sources')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createSource(@Body(zodBody(createSourceSchema)) body: unknown) {
    return withMessage(
      await this.config.createSource(body as Parameters<CrmConfigService['createSource']>[0]),
      'Source created',
    );
  }

  @Patch('sources/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateSource(@Param('id') id: string, @Body(zodBody(updateSourceSchema)) body: unknown) {
    return withMessage(
      await this.config.updateSource(id, body as Parameters<CrmConfigService['updateSource']>[1]),
      'Source updated',
    );
  }

  @Delete('sources/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async deleteSource(@Param('id') id: string) {
    return withMessage(await this.config.deleteSource(id), 'Source deleted');
  }

  // ── Lost reasons ──────────────────────────────────────────────────────────

  @Get('lost-reasons')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listLostReasons(@Query(new ZodBody(listQuerySchema)) query: ListQuery) {
    return this.config.listLostReasons(query.includeInactive);
  }

  @Post('lost-reasons')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createLostReason(@Body(zodBody(createLostReasonSchema)) body: unknown) {
    return withMessage(
      await this.config.createLostReason(
        body as Parameters<CrmConfigService['createLostReason']>[0],
      ),
      'Lost reason created',
    );
  }

  @Patch('lost-reasons/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateLostReason(
    @Param('id') id: string,
    @Body(zodBody(updateLostReasonSchema)) body: unknown,
  ) {
    return withMessage(
      await this.config.updateLostReason(
        id,
        body as Parameters<CrmConfigService['updateLostReason']>[1],
      ),
      'Lost reason updated',
    );
  }

  @Delete('lost-reasons/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async deleteLostReason(@Param('id') id: string) {
    return withMessage(await this.config.deleteLostReason(id), 'Lost reason deleted');
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  @Get('tags')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listTags() {
    return this.config.listTags();
  }

  /**
   * Creating a tag is part of working a lead, not a settings change — an executive labels someone
   * "Investor" mid-conversation. Idempotent, so a colleague having typed it first is not an error.
   */
  @Post('tags')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.LEAD_UPDATE)
  async createTag(@Body(zodBody(createTagSchema)) body: unknown) {
    const result = await this.config.ensureTag(
      body as Parameters<CrmConfigService['ensureTag']>[0],
    );
    return withMessage(result, result.created ? 'Tag created' : 'That tag already existed');
  }

  @Patch('tags/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateTag(@Param('id') id: string, @Body(zodBody(updateTagSchema)) body: unknown) {
    return withMessage(
      await this.config.updateTag(id, body as Parameters<CrmConfigService['updateTag']>[1]),
      'Tag updated',
    );
  }

  @Delete('tags/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async deleteTag(@Param('id') id: string) {
    return withMessage(await this.config.deleteTag(id), 'Tag deleted');
  }

  // ── Pipelines ─────────────────────────────────────────────────────────────

  @Get('pipelines')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listPipelines(@Query(new ZodBody(listQuerySchema)) query: ListQuery) {
    return this.config.listPipelines(query.includeInactive);
  }

  @Post('pipelines')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.PIPELINE_MANAGE)
  async createPipeline(@Body(zodBody(createPipelineSchema)) body: unknown) {
    return withMessage(
      await this.config.createPipeline(body as Parameters<CrmConfigService['createPipeline']>[0]),
      'Pipeline created',
    );
  }

  @Patch('pipelines/:id')
  @RequirePermission(PERMISSIONS.PIPELINE_MANAGE)
  async updatePipeline(
    @Param('id') id: string,
    @Body(zodBody(updatePipelineSchema)) body: unknown,
  ) {
    return withMessage(
      await this.config.updatePipeline(
        id,
        body as Parameters<CrmConfigService['updatePipeline']>[1],
      ),
      'Pipeline updated',
    );
  }

  /** PUT: the stage editor submits the intended final board, in order. */
  @Put('pipelines/:id/stages')
  @RequirePermission(PERMISSIONS.PIPELINE_MANAGE)
  async setStages(@Param('id') id: string, @Body(zodBody(setStagesSchema)) body: unknown) {
    return withMessage(
      await this.config.setStages(id, body as Parameters<CrmConfigService['setStages']>[1]),
      'Stages updated',
    );
  }

  @Delete('pipelines/:id')
  @RequirePermission(PERMISSIONS.PIPELINE_MANAGE)
  async deletePipeline(@Param('id') id: string) {
    return withMessage(await this.config.deletePipeline(id), 'Pipeline deleted');
  }
}
