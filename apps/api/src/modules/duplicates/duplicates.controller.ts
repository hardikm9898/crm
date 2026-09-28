import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { z } from 'zod';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { DuplicatesService } from './duplicates.service.js';
import { MergeService } from './merge.service.js';
import {
  createDuplicateRuleSchema,
  listDuplicatesSchema,
  mergeLeadsSchema,
  testDuplicateSchema,
  updateDuplicateRuleSchema,
  type ListDuplicatesQuery,
} from './duplicates.dto.js';

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
 * Duplicate rules, the triage queue, and merges.
 *
 * Permissions split along what the act actually is: **reading** the queue needs `lead:read`, because
 * it is a view of leads; **merging or dismissing** needs `lead:merge`, because it changes records
 * irreversibly enough to want its own grant; **configuring rules** needs `settings:manage`, because a
 * bad rule affects every future capture rather than one record.
 */
@Controller('duplicates')
export class DuplicatesController {
  constructor(
    private readonly duplicates: DuplicatesService,
    private readonly merges: MergeService,
  ) {}

  // ── The triage queue ──────────────────────────────────────────────────────

  @Get()
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async list(@Query(new ZodBody(listDuplicatesSchema)) query: ListDuplicatesQuery) {
    return this.duplicates.listDuplicates(query);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_MERGE)
  async dismiss(@Param('id') id: string) {
    return withMessage(
      await this.duplicates.dismiss(id),
      'Recorded as different people. The same pair will not be raised again',
    );
  }

  // ── Merging ───────────────────────────────────────────────────────────────

  /** The fields a merge may choose between, so a merge screen does not hardcode them. */
  @Get('mergeable-fields')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async mergeableFields() {
    const items = this.merges.mergeableFields().map((field) => ({ field }));
    return {
      items,
      pagination: { limit: items.length, nextCursor: null, hasMore: false, total: items.length },
    };
  }

  @Post('merge')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_MERGE)
  async merge(@Body(zodBody(mergeLeadsSchema)) body: unknown) {
    return withMessage(
      await this.merges.merge(body as Parameters<MergeService['merge']>[0]),
      'Leads merged. This can be undone',
    );
  }

  @Post('merges/:id/undo')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_MERGE)
  async undo(@Param('id') id: string) {
    return withMessage(await this.merges.undo(id), 'Merge undone. Both leads are back');
  }

  // ── Rules ─────────────────────────────────────────────────────────────────

  /** What a rule may match on, and how each field is compared. */
  @Get('matchable-fields')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async matchableFields() {
    return this.duplicates.matchableFields();
  }

  @Get('rules')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async listRules(@Query(new ZodBody(listRulesSchema)) query: ListRulesQuery) {
    return this.duplicates.listRules(query.includeInactive);
  }

  @Post('rules')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async createRule(@Body(zodBody(createDuplicateRuleSchema)) body: unknown) {
    return withMessage(
      await this.duplicates.createRule(body as Parameters<DuplicatesService['createRule']>[0]),
      'Rule created — it applies to the next capture',
    );
  }

  @Patch('rules/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateRule(
    @Param('id') id: string,
    @Body(zodBody(updateDuplicateRuleSchema)) body: unknown,
  ) {
    return withMessage(
      await this.duplicates.updateRule(id, body as Parameters<DuplicatesService['updateRule']>[1]),
      'Rule updated',
    );
  }

  @Delete('rules/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async deleteRule(@Param('id') id: string) {
    return withMessage(
      await this.duplicates.deleteRule(id),
      'Rule removed. The pairs it already found are kept',
    );
  }

  /**
   * Runs the live rules against a hypothetical capture. Writes nothing, and uses the same code the
   * write path does — a tester that disagreed with reality would be worse than none.
   */
  @Post('test')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async test(@Body(zodBody(testDuplicateSchema)) body: unknown) {
    return this.duplicates.testRules(body as Parameters<DuplicatesService['testRules']>[0]);
  }
}
