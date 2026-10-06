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
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { QuotationsService } from './quotations.service.js';
import { QuotationPdfService } from './quotation-pdf.service.js';
import { NUMBER_SERIES_KINDS, NumberSeriesService } from './number-series.service.js';
import {
  acceptQuotationSchema,
  createQuotationSchema,
  listQuotationsSchema,
  rejectQuotationSchema,
  reviseQuotationSchema,
  sendQuotationSchema,
  setQuotationItemsSchema,
  updateNumberSeriesSchema,
  updateQuotationSchema,
  type AcceptQuotationInput,
  type ListQuotationsQuery,
  type RejectQuotationInput,
  type ReviseQuotationInput,
  type SendQuotationInput,
  type SetQuotationItemsInput,
  type UpdateNumberSeriesInput,
  type UpdateQuotationInput,
} from './quotations.dto.js';

/**
 * Quotations (`FR-DEAL-2`).
 *
 * `deal:read` and `deal:manage`, deliberately: a quotation is part of the deal surface, and the
 * permission catalogue has said "deals and quotations" since Phase 1. Somebody who may price a deal
 * may quote it; a separate permission would only create workspaces where one of the two is
 * impossible.
 *
 * Every lifecycle move is its own endpoint — send, accept, reject, revise — because each has its own
 * preconditions, its own timeline entry and its own event, and a PATCH that happened to include
 * `status` could check none of them. That is the same reason a lead's status move is a POST.
 */
@Controller('quotations')
export class QuotationsController {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly pdf: QuotationPdfService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async list(@Query(new ZodBody(listQuotationsSchema)) query: ListQuotationsQuery) {
    return this.quotations.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async create(@Body(zodBody(createQuotationSchema)) body: unknown) {
    const quotation = await this.quotations.create(body as never);
    return withMessage(quotation, `Quotation ${quotation.number} created`);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async findOne(@Param('id') id: string) {
    return this.quotations.findOne(id);
  }

  /**
   * The document itself.
   *
   * Straight through the reply — a download is not an envelope — and `inline` rather than
   * `attachment`, because the first thing anybody does with a quotation is look at it. The relay in
   * the web app passes these headers through unchanged.
   */
  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.DEAL_READ)
  async download(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    // The read permission is the route's; the tenant and scope checks are the service's.
    await this.quotations.findOne(id);
    const file = await this.pdf.forQuotation(id);
    await reply
      .header('content-type', file.mimeType)
      .header('content-disposition', `inline; filename="${file.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(file.body);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateQuotationSchema)) body: unknown) {
    const quotation = await this.quotations.update(id, body as UpdateQuotationInput);
    return withMessage(quotation, 'Quotation saved');
  }

  @Put(':id/items')
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async setItems(@Param('id') id: string, @Body(zodBody(setQuotationItemsSchema)) body: unknown) {
    const quotation = await this.quotations.setItems(id, body as SetQuotationItemsInput);
    return withMessage(quotation, 'Lines saved');
  }

  @Post(':id/send')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async send(@Param('id') id: string, @Body(zodBody(sendQuotationSchema)) body: unknown) {
    const quotation = await this.quotations.send(id, body as SendQuotationInput);
    return withMessage(quotation, `Quotation ${quotation.number} marked sent`);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async accept(@Param('id') id: string, @Body(zodBody(acceptQuotationSchema)) body: unknown) {
    const quotation = await this.quotations.accept(id, body as AcceptQuotationInput);
    return withMessage(quotation, 'Quotation accepted');
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async reject(@Param('id') id: string, @Body(zodBody(rejectQuotationSchema)) body: unknown) {
    const quotation = await this.quotations.reject(id, body as RejectQuotationInput);
    return withMessage(quotation, 'Quotation marked rejected');
  }

  @Post(':id/revise')
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async revise(@Param('id') id: string, @Body(zodBody(reviseQuotationSchema)) body: unknown) {
    const quotation = await this.quotations.revise(id, body as ReviseQuotationInput);
    return withMessage(quotation, `Revision ${quotation.version} created as a draft`);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.DEAL_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(await this.quotations.remove(id), 'Draft quotation deleted');
  }
}

/**
 * The quotation number series.
 *
 * Under `settings` rather than `quotations`, and gated on `settings:manage`: the prefix and the
 * counter are configuration a workspace sets once, and somebody who may raise a quotation should
 * not be able to renumber every quotation that follows.
 */
@Controller('settings/number-series')
export class NumberSeriesController {
  constructor(private readonly series: NumberSeriesService) {}

  @Get('quotation')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async readQuotationSeries() {
    return this.series.read(NUMBER_SERIES_KINDS.QUOTATION);
  }

  @Patch('quotation')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async updateQuotationSeries(@Body(zodBody(updateNumberSeriesSchema)) body: unknown) {
    const series = await this.series.update(
      NUMBER_SERIES_KINDS.QUOTATION,
      body as UpdateNumberSeriesInput,
    );
    return withMessage(series, `The next quotation will be ${series.nextNumber}`);
  }
}
