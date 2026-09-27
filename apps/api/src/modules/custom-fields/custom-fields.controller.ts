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
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { CustomFieldsService } from './custom-fields.service.js';
import {
  createFieldSchema,
  createSectionSchema,
  listFieldsSchema,
  setOptionsSchema,
  updateFieldSchema,
  updateSectionSchema,
  type ListFieldsQuery,
} from './custom-fields.dto.js';

/**
 * The field builder.
 *
 * **Reading definitions needs `lead:read`, not `settings:read`.** A sales executive has to be able to
 * render a lead form, and they do not hold `settings:read` — gating the vocabulary behind a settings
 * permission would leave them looking at a form with half its fields missing. Defining fields is a
 * different act and needs `custom_field:manage`.
 */
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async list(@Query(new ZodBody(listFieldsSchema)) query: ListFieldsQuery) {
    return this.fields.list(query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  async create(@Body(zodBody(createFieldSchema)) body: unknown) {
    return withMessage(
      await this.fields.create(body as Parameters<CustomFieldsService['create']>[0]),
      'Field created — it is usable straight away',
    );
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateFieldSchema)) body: unknown) {
    return withMessage(
      await this.fields.update(id, body as Parameters<CustomFieldsService['update']>[1]),
      'Field updated',
    );
  }

  /** PUT: an options editor submits the intended final list, not a delta. */
  @Put(':id/options')
  @RequirePermission(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  async setOptions(@Param('id') id: string, @Body(zodBody(setOptionsSchema)) body: unknown) {
    return withMessage(
      await this.fields.setOptions(id, body as Parameters<CustomFieldsService['setOptions']>[1]),
      'Options updated',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(
      await this.fields.remove(id),
      'Field removed. Values already recorded are kept, so history stays accurate',
    );
  }

  // ── Sections ──────────────────────────────────────────────────────────────

  @Get('sections')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listSections(@Query(new ZodBody(listFieldsSchema)) query: ListFieldsQuery) {
    return this.fields.listSections(query.entityType);
  }

  @Post('sections')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  async createSection(@Body(zodBody(createSectionSchema)) body: unknown) {
    return withMessage(
      await this.fields.createSection(body as Parameters<CustomFieldsService['createSection']>[0]),
      'Section created',
    );
  }

  @Patch('sections/:id')
  @RequirePermission(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  async updateSection(@Param('id') id: string, @Body(zodBody(updateSectionSchema)) body: unknown) {
    return withMessage(
      await this.fields.updateSection(
        id,
        body as Parameters<CustomFieldsService['updateSection']>[1],
      ),
      'Section updated',
    );
  }

  @Delete('sections/:id')
  @RequirePermission(PERMISSIONS.CUSTOM_FIELD_MANAGE)
  async deleteSection(@Param('id') id: string) {
    return withMessage(
      await this.fields.deleteSection(id),
      'Section removed. Its fields are still available, just ungrouped',
    );
  }
}
