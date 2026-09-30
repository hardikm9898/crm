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
import { ScoringService } from './scoring.service.js';
import {
  createScoringRuleSchema,
  listScoringRulesSchema,
  setBandsSchema,
  testScoringSchema,
  updateScoringRuleSchema,
  type ListScoringRulesQuery,
} from './scoring.dto.js';

/**
 * Scoring rules, bands and the tester.
 *
 * Reading is `lead:read` — a score is a property of a lead, and an executive needs to see why
 * theirs is hot. Changing rules or bands is `settings:manage`: a band edit reclassifies every lead
 * in the workspace at once, which is a configuration act rather than a record-level one.
 */
@Controller('scoring')
export class ScoringController {
  constructor(private readonly scoring: ScoringService) {}

  /** The triggers a rule may use, live and dormant, so a rule builder has no hardcoded list. */
  @Get('triggers')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  triggers() {
    return this.scoring.triggers();
  }

  @Get('rules')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listRules(@Query(new ZodBody(listScoringRulesSchema)) query: ListScoringRulesQuery) {
    return this.scoring.listRules(query);
  }

  @Post('rules')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createRule(@Body(zodBody(createScoringRuleSchema)) body: unknown) {
    return withMessage(
      await this.scoring.createRule(body as Parameters<ScoringService['createRule']>[0]),
      'Scoring rule created. It applies from the next matching event',
    );
  }

  @Patch('rules/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateRule(@Param('id') id: string, @Body(zodBody(updateScoringRuleSchema)) body: unknown) {
    return withMessage(
      await this.scoring.updateRule(id, body as Parameters<ScoringService['updateRule']>[1]),
      'Scoring rule updated',
    );
  }

  @Delete('rules/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async deleteRule(@Param('id') id: string) {
    return withMessage(
      await this.scoring.deleteRule(id),
      'Scoring rule deleted. Points it already awarded stay on their leads',
    );
  }

  @Get('bands')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listBands() {
    return this.scoring.listBands();
  }

  /** PUT, because the bands are only valid as a complete partition of the score range. */
  @Put('bands')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async setBands(@Body(zodBody(setBandsSchema)) body: unknown) {
    return withMessage(
      await this.scoring.setBands(body as Parameters<ScoringService['setBands']>[0]),
      'Bands saved, and every lead re-banded',
    );
  }

  /** "What would this lead score, and why?" Writes nothing. */
  @Post('test')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async test(@Body(zodBody(testScoringSchema)) body: unknown) {
    return this.scoring.test(body as Parameters<ScoringService['test']>[0]);
  }
}
