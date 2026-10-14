import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { CallsService } from './calls.service.js';
import { CallOutcomesService } from './call-outcomes.service.js';
import {
  createCallOutcomeSchema,
  dialCallSchema,
  listCallsSchema,
  logCallSchema,
  settleCallSchema,
  updateCallOutcomeSchema,
  updateCallSchema,
  type CreateCallOutcomeInput,
  type DialCallInput,
  type ListCallsQuery,
  type LogCallInput,
  type SettleCallInput,
  type UpdateCallInput,
  type UpdateCallOutcomeInput,
} from './calls.dto.js';

/**
 * Calls (`FR-CALL-1..3`).
 *
 * `POST /calls/dial` needs `call:log` rather than `call:read`, which is the whole reason the two
 * permissions are separate: a workspace can let somebody read what the team did on the phone
 * without letting them ring a customer from the product. An auditor holds `call:read` alone.
 *
 * `GET /calls/config` is readable with `call:read` rather than `settings:manage`, like the task
 * form's: the outcome dropdown is part of logging a call, and a sales executive has no business
 * holding a settings permission to do their job.
 */
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CALL_READ)
  async list(@Query(new ZodBody(listCallsSchema)) query: ListCallsQuery) {
    return this.calls.list(query);
  }

  /** The outcome list, and what the dial button will actually do. */
  @Get('config')
  @RequirePermission(PERMISSIONS.CALL_READ)
  async config() {
    return this.calls.config();
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.CALL_LOG)
  async log(@Body(zodBody(logCallSchema)) body: unknown) {
    const result = await this.calls.log(body as LogCallInput);
    return withMessage(
      result,
      result.followUpCompleted ? 'Call logged and follow-up closed' : 'Call logged',
    );
  }

  /** Click-to-call. Answers how the call is being placed, because the two are different. */
  @Post('dial')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.CALL_LOG)
  async dial(@Body(zodBody(dialCallSchema)) body: unknown) {
    const result = await this.calls.dial(body as DialCallInput);
    return withMessage(
      result,
      result.dial.mode === 'device' ? 'Opening your phone' : 'Calling now',
    );
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CALL_READ)
  async findOne(@Param('id') id: string) {
    return this.calls.findOne(id);
  }

  /** What happened on a call the product dialled. Its own endpoint — see the DTO. */
  @Post(':id/outcome')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.CALL_LOG)
  async settle(@Param('id') id: string, @Body(zodBody(settleCallSchema)) body: unknown) {
    return withMessage(await this.calls.settle(id, body as SettleCallInput), 'Call outcome saved');
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CALL_LOG)
  async update(@Param('id') id: string, @Body(zodBody(updateCallSchema)) body: unknown) {
    return withMessage(await this.calls.update(id, body as UpdateCallInput), 'Call saved');
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.CALL_LOG)
  async remove(@Param('id') id: string) {
    return withMessage(await this.calls.remove(id), 'Call removed');
  }
}

/**
 * The tenant's own list of what a call meant (rule 4).
 *
 * Readable with `call:read` so the outcome form can render; writable with `settings:manage` like
 * every other piece of workspace configuration.
 */
@Controller('settings/call-outcomes')
export class CallOutcomesController {
  constructor(private readonly outcomes: CallOutcomesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CALL_READ)
  async list(@Query('includeInactive') includeInactive?: string) {
    return this.outcomes.list(includeInactive === 'true');
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async create(@Body(zodBody(createCallOutcomeSchema)) body: unknown) {
    return withMessage(
      await this.outcomes.create(body as CreateCallOutcomeInput),
      'Call outcome added',
    );
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateCallOutcomeSchema)) body: unknown) {
    return withMessage(
      await this.outcomes.update(id, body as UpdateCallOutcomeInput),
      'Call outcome saved',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(await this.outcomes.remove(id), 'Call outcome removed');
  }
}
