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
import { AssignmentService } from './assignment.service.js';
import {
  createAssignmentRuleSchema,
  evaluateAssignmentSchema,
  reassignBulkSchema,
  setConditionsSchema,
  setPoolSchema,
  testAssignmentSchema,
  updateAssignmentRuleSchema,
} from './assignment.dto.js';

const listRulesSchema = z
  .object({
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

type ListRulesQuery = z.infer<typeof listRulesSchema>;

/**
 * The assignment engine's configuration and its tester.
 *
 * Rules are configuration (`settings:manage`); reassigning leads is lead work (`lead:assign`).
 * Reading the rules and running the tester need only `lead:read`, because "why did this lead come to
 * me" is a question the person holding the lead is entitled to ask.
 */
@Controller('assignment')
export class AssignmentController {
  constructor(private readonly assignment: AssignmentService) {}

  /** The strategies, with what each needs — so a rule builder renders from the registry. */
  @Get('strategies')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async strategies() {
    return this.assignment.strategies();
  }

  @Get('rules')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listRules(@Query(new ZodBody(listRulesSchema)) query: ListRulesQuery) {
    return this.assignment.listRules(query.includeInactive);
  }

  @Post('rules')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createRule(@Body(zodBody(createAssignmentRuleSchema)) body: unknown) {
    return withMessage(
      await this.assignment.createRule(body as Parameters<AssignmentService['createRule']>[0]),
      'Rule created — it applies to the next lead',
    );
  }

  @Patch('rules/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateRule(
    @Param('id') id: string,
    @Body(zodBody(updateAssignmentRuleSchema)) body: unknown,
  ) {
    return withMessage(
      await this.assignment.updateRule(id, body as Parameters<AssignmentService['updateRule']>[1]),
      'Rule updated',
    );
  }

  /** PUT: the condition editor submits the intended final set. */
  @Put('rules/:id/conditions')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async setConditions(@Param('id') id: string, @Body(zodBody(setConditionsSchema)) body: unknown) {
    return withMessage(
      await this.assignment.setConditions(
        id,
        body as Parameters<AssignmentService['setConditions']>[1],
      ),
      'Conditions updated',
    );
  }

  /** PUT: the pool editor submits the intended final membership. Resets the rotation. */
  @Put('rules/:id/pool')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async setPool(@Param('id') id: string, @Body(zodBody(setPoolSchema)) body: unknown) {
    return withMessage(
      await this.assignment.setPool(id, body as Parameters<AssignmentService['setPool']>[1]),
      'Pool updated. The rotation starts again from the top',
    );
  }

  @Delete('rules/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async deleteRule(@Param('id') id: string) {
    return withMessage(await this.assignment.deleteRule(id), 'Rule removed');
  }

  /**
   * The rule tester. Writes nothing, runs the real engine, and shows which rules matched, who was
   * considered, and why each ineligible person was skipped.
   */
  @Post('test')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async test(@Body(zodBody(testAssignmentSchema)) body: unknown) {
    return this.assignment.test(body as Parameters<AssignmentService['test']>[0]);
  }

  /** Re-runs the rules over existing leads (`FR-ASG-1`). */
  @Post('evaluate')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_ASSIGN)
  async evaluate(@Body(zodBody(evaluateAssignmentSchema)) body: unknown) {
    return this.assignment.evaluate(body as Parameters<AssignmentService['evaluate']>[0]);
  }

  /** Bulk manual reassignment (`FR-ASG-6`). Reports what it skipped and why. */
  @Post('reassign')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_ASSIGN)
  async reassign(@Body(zodBody(reassignBulkSchema)) body: unknown) {
    return withMessage(
      await this.assignment.reassignBulk(body as Parameters<AssignmentService['reassignBulk']>[0]),
      'Leads reassigned',
    );
  }
}
