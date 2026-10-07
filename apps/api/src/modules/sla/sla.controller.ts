import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { SlaService } from './sla.service.js';
import { SlaPoliciesService } from './sla-policies.service.js';
import {
  createSlaPolicySchema,
  listClocksSchema,
  listEscalationsSchema,
  slaBoardSchema,
  updateSlaPolicySchema,
  type CreateSlaPolicyInput,
  type ListClocksQuery,
  type ListEscalationsQuery,
  type SlaBoardQuery,
  type UpdateSlaPolicyInput,
} from './sla.dto.js';

/**
 * SLA clocks, the breach board and escalations (`FR-TSK-8`).
 *
 * Read with `sla:read`, which a sales executive holds at `own` scope and a manager at `branch`:
 * somebody who cannot see that their own lead is forty minutes from a breach cannot do anything
 * about it, and an escalation they never saw coming is a reprimand rather than a reminder.
 *
 * There is **no endpoint that starts or satisfies a clock.** Both happen as part of the write that
 * caused them — a lead being captured, a follow-up being completed — inside the same transaction.
 * An endpoint that let a client mark its own SLA met would make the whole measurement worthless.
 */
@Controller('sla')
export class SlaController {
  constructor(
    private readonly sla: SlaService,
    private readonly policies: SlaPoliciesService,
  ) {}

  /** The manager's board: counts over the whole filter, plus the clocks running out soonest. */
  @Get('board')
  @RequirePermission(PERMISSIONS.SLA_READ)
  async board(@Query(new ZodBody(slaBoardSchema)) query: SlaBoardQuery) {
    return this.sla.board(query);
  }

  @Get('clocks')
  @RequirePermission(PERMISSIONS.SLA_READ)
  async clocks(@Query(new ZodBody(listClocksSchema)) query: ListClocksQuery) {
    return this.sla.list(query);
  }

  @Get('escalations')
  @RequirePermission(PERMISSIONS.SLA_READ)
  async escalations(@Query(new ZodBody(listEscalationsSchema)) query: ListEscalationsQuery) {
    return this.sla.escalations(query);
  }

  /**
   * "I have seen it."
   *
   * `sla:read` rather than a write permission: acknowledging is a statement about the reader, not a
   * change to the lead, and requiring `settings:manage` would mean the person who was escalated to
   * could not clear it.
   */
  @Post('escalations/:id/acknowledge')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.SLA_READ)
  async acknowledge(@Param('id') id: string) {
    return withMessage(await this.sla.acknowledge(id), 'Marked as seen');
  }

  @Get('policies')
  @RequirePermission(PERMISSIONS.SLA_READ)
  async listPolicies(@Query('includeInactive') includeInactive?: string) {
    return this.policies.list(includeInactive === 'true');
  }

  @Post('policies')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createPolicy(@Body(zodBody(createSlaPolicySchema)) body: unknown) {
    return withMessage(
      await this.policies.create(body as CreateSlaPolicyInput),
      'SLA policy created',
    );
  }

  @Patch('policies/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updatePolicy(@Param('id') id: string, @Body(zodBody(updateSlaPolicySchema)) body: unknown) {
    return withMessage(
      await this.policies.update(id, body as UpdateSlaPolicyInput),
      'SLA policy saved. Clocks already running keep the target they were started with',
    );
  }

  @Delete('policies/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async removePolicy(@Param('id') id: string) {
    return withMessage(await this.policies.remove(id), 'SLA policy removed');
  }
}
