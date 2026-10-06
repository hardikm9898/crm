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
import { CustomersService } from '../customers/customers.service.js';
import { convertLeadSchema, type ConvertLeadInput } from '../customers/customers.dto.js';
import { LeadsService } from './leads.service.js';
import { LeadTimelineService } from './lead-timeline.service.js';
import {
  addTouchpointSchema,
  assignLeadSchema,
  changeStageSchema,
  changeStatusSchema,
  createLeadSchema,
  listLeadsSchema,
  setTagsSchema,
  timelineQuerySchema,
  updateLeadSchema,
  type ListLeadsQuery,
  type TimelineQuery,
} from './leads.dto.js';
import { searchLeadsSchema } from '../views/views.dto.js';

/**
 * Leads.
 *
 * Transitions are separate endpoints rather than fields on the PATCH: each carries its own
 * permission (`lead:assign` is not `lead:update`), its own preconditions and its own history. A
 * client that could move a lead's stage by including `stageId` in a general update would bypass the
 * stage's required-field check.
 */
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly timeline: LeadTimelineService,
    private readonly customers: CustomersService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async list(@Query(new ZodBody(listLeadsSchema)) query: ListLeadsQuery) {
    // Breadth comes from the caller's grant, not the query: an executive asking for every lead
    // still gets only their own.
    return this.leads.list(query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.LEAD_CREATE)
  async create(@Body(zodBody(createLeadSchema)) body: unknown) {
    return withMessage(
      await this.leads.create(body as Parameters<LeadsService['create']>[0]),
      'Lead created',
    );
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async findOne(@Param('id') id: string) {
    return this.leads.findOne(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.LEAD_UPDATE)
  async update(@Param('id') id: string, @Body(zodBody(updateLeadSchema)) body: unknown) {
    return withMessage(
      await this.leads.update(id, body as Parameters<LeadsService['update']>[1]),
      'Lead updated',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.LEAD_DELETE)
  async remove(@Param('id') id: string) {
    return withMessage(
      await this.leads.remove(id),
      'Lead moved to the recycle bin. It can be restored',
    );
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_DELETE)
  async restore(@Param('id') id: string) {
    return withMessage(await this.leads.restore(id), 'Lead restored');
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_UPDATE)
  async changeStatus(@Param('id') id: string, @Body(zodBody(changeStatusSchema)) body: unknown) {
    return withMessage(
      await this.leads.changeStatus(id, body as Parameters<LeadsService['changeStatus']>[1]),
      'Status updated',
    );
  }

  @Post(':id/stage')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_UPDATE)
  async changeStage(@Param('id') id: string, @Body(zodBody(changeStageSchema)) body: unknown) {
    return withMessage(
      await this.leads.changeStage(id, body as Parameters<LeadsService['changeStage']>[1]),
      'Stage updated',
    );
  }

  /**
   * Converting a lead into a customer (`FR-DEAL-4`).
   *
   * On the lead rather than on `/customers`, because this is a lead transition that happens to
   * produce a customer: a client holding a lead should not have to know a second resource exists to
   * finish the sale. `customer:manage` is the permission — creating a customer is what it does —
   * and the service additionally requires the lead to be inside the caller's `lead:update` scope,
   * so converting another branch's lead is not something a customer permission can grant.
   */
  @Post(':id/convert')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.CUSTOMER_MANAGE)
  async convert(@Param('id') id: string, @Body(zodBody(convertLeadSchema)) body: unknown) {
    return withMessage(
      await this.customers.convert(id, body as ConvertLeadInput),
      'Converted. Their whole history came with them',
    );
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_ASSIGN)
  async assign(@Param('id') id: string, @Body(zodBody(assignLeadSchema)) body: unknown) {
    return withMessage(
      await this.leads.assign(id, body as Parameters<LeadsService['assign']>[1]),
      'Lead assigned',
    );
  }

  /** PUT: the tag editor submits the intended final set. */
  @Put(':id/tags')
  @RequirePermission(PERMISSIONS.LEAD_UPDATE)
  async setTags(@Param('id') id: string, @Body(zodBody(setTagsSchema)) body: unknown) {
    return withMessage(
      await this.leads.setTags(id, body as Parameters<LeadsService['setTags']>[1]),
      'Tags updated',
    );
  }

  /**
   * Records another contact with the same person. Appends — a lead reached through three channels
   * has three touchpoints, and the first one is never overwritten (`FR-ATT-1`).
   */
  @Post(':id/touchpoints')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.LEAD_UPDATE)
  async addTouchpoint(@Param('id') id: string, @Body(zodBody(addTouchpointSchema)) body: unknown) {
    return withMessage(
      await this.leads.addTouchpoint(id, body as Parameters<LeadsService['addTouchpoint']>[1]),
      'Touchpoint recorded',
    );
  }

  // ── Timeline ──────────────────────────────────────────────────────────────

  @Get(':id/timeline')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async timelineFor(
    @Param('id') id: string,
    @Query(new ZodBody(timelineQuerySchema)) query: TimelineQuery,
  ) {
    return this.timeline.forLead(id, query);
  }

  // ── Filtered search and scoring ───────────────────────────────────────────

  /**
   * The filter-driven list (`FR-VIEW-2`).
   *
   * A POST that reads: a filter is a nested object and a saved view's filter can exceed what a URL
   * should carry. `GET /leads` keeps the simple parameters for links and bookmarks.
   */
  @Post('search')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async search(@Body(zodBody(searchLeadsSchema)) body: unknown) {
    return this.leads.search(body as Parameters<LeadsService['search']>[0]);
  }

  /** Which rules gave this lead its points (`FR-SCR-2`). */
  @Get(':id/score-breakdown')
  @RequirePermission(PERMISSIONS.LEAD_READ)
  async scoreBreakdown(@Param('id') id: string) {
    return this.leads.scoreBreakdown(id);
  }

  /** Re-sums the score events and corrects the cached score. Writes, hence `lead:update`. */
  @Post(':id/recompute-score')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.LEAD_UPDATE)
  async recomputeScore(@Param('id') id: string) {
    return withMessage(await this.leads.recomputeScore(id), 'Score recalculated');
  }
}
