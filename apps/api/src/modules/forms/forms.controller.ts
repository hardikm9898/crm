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
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { FormsService } from './forms.service.js';
import {
  createFormSchema,
  listFormsSchema,
  listSubmissionsSchema,
  setFormFieldsSchema,
  updateFormSchema,
  type CreateFormInput,
  type ListFormsQuery,
  type ListSubmissionsQuery,
  type SetFormFieldsInput,
  type UpdateFormInput,
} from './forms.dto.js';

/**
 * Capture forms, for the workspace (`FR-CAP-2`).
 *
 * `form:manage` rather than `settings:manage`: a form decides which pipeline a capture enters,
 * which source it is attributed to and which rule assigns it, and its public key is reachable by
 * anybody on the internet — so it is its own permission, held by the marketing manager who builds
 * the campaign and by nobody who merely works leads.
 *
 * `GET /forms/builder-options` is readable with `form:manage` rather than `form:read`, because the
 * list it serves is "what a public form may ask a stranger for" and only somebody building one
 * needs it.
 */
@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.FORM_READ)
  async list(@Query(new ZodBody(listFormsSchema)) query: ListFormsQuery) {
    return this.forms.list(query);
  }

  /** The standard questions, and this workspace's own lead fields. */
  @Get('builder-options')
  @RequirePermission(PERMISSIONS.FORM_MANAGE)
  async builderOptions() {
    return this.forms.builderOptions();
  }

  /** Every submission, whatever became of it — including the ones that became nothing. */
  @Get('submissions')
  @RequirePermission(PERMISSIONS.FORM_READ)
  async submissions(@Query(new ZodBody(listSubmissionsSchema)) query: ListSubmissionsQuery) {
    return this.forms.submissions(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.FORM_READ)
  async findOne(@Param('id') id: string) {
    return this.forms.findOne(id);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.FORM_MANAGE)
  async create(@Body(zodBody(createFormSchema)) body: unknown) {
    const form = await this.forms.create(body as CreateFormInput);
    return withMessage(form, 'Form created');
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.FORM_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateFormSchema)) body: unknown) {
    const form = await this.forms.update(id, body as UpdateFormInput);
    return withMessage(form, 'Form updated');
  }

  /** The whole ordered field set, replaced. A builder screen edits a list, not rows. */
  @Put(':id/fields')
  @RequirePermission(PERMISSIONS.FORM_MANAGE)
  async setFields(@Param('id') id: string, @Body(zodBody(setFormFieldsSchema)) body: unknown) {
    const form = await this.forms.setFields(id, body as SetFormFieldsInput);
    return withMessage(form, 'Questions saved');
  }

  /** A new public URL. The old one stops answering immediately, which is the point. */
  @Post(':id/rotate-key')
  @RequirePermission(PERMISSIONS.FORM_MANAGE)
  async rotateKey(@Param('id') id: string) {
    const form = await this.forms.rotateKey(id);
    return withMessage(form, 'New link created — the old one no longer works');
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.FORM_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(await this.forms.remove(id), 'Form deleted');
  }
}
