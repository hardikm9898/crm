import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { WebhooksService } from './webhooks.service.js';
import {
  createWebhookEndpointSchema,
  listDeliveriesSchema,
  updateWebhookEndpointSchema,
  type CreateWebhookEndpointInput,
  type ListDeliveriesQuery,
  type UpdateWebhookEndpointInput,
} from './webhooks.dto.js';

/**
 * Outbound webhooks (`FR-API-4`).
 *
 * All of it behind `webhook:manage`, which has been in the catalogue since Phase 1 with nothing
 * reading it. There is no read-only view: an endpoint's delivery log carries the payloads of events
 * about the workspace's own leads, and somebody who may read those may already read the leads.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async list() {
    return this.webhooks.list();
  }

  /**
   * Declared **before** `:id`, or `/webhooks/deliveries` is read as an endpoint id and answers 404
   * from the global UUID pipe.
   */
  @Get('deliveries')
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async deliveries(@Query(new ZodBody(listDeliveriesSchema)) query: ListDeliveriesQuery) {
    return this.webhooks.deliveries(query);
  }

  @Post('deliveries/:id/retry')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async retry(@Param('id') id: string) {
    return withMessage(await this.webhooks.retry(id), 'Sending it again now');
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async findOne(@Param('id') id: string) {
    return this.webhooks.findOne(id);
  }

  /**
   * One endpoint's log, which is what §5 names. The flat `/webhooks/deliveries` above is the
   * workspace's whole recent log — the view somebody debugging opens first, before they know which
   * endpoint is at fault — and both are the same query with the same filter.
   */
  @Get(':id/deliveries')
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async deliveriesFor(
    @Param('id') id: string,
    @Query(new ZodBody(listDeliveriesSchema)) query: ListDeliveriesQuery,
  ) {
    return this.webhooks.deliveries({ ...query, endpointId: id });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async create(@Body(zodBody(createWebhookEndpointSchema)) body: unknown) {
    const created = await this.webhooks.create(body as CreateWebhookEndpointInput);
    return withMessage(
      created,
      'Endpoint created — copy the signing secret now, it is not shown again',
    );
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updateWebhookEndpointSchema)) body: unknown) {
    return withMessage(
      await this.webhooks.update(id, body as UpdateWebhookEndpointInput),
      'Endpoint updated',
    );
  }

  @Post(':id/rotate-secret')
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async rotate(@Param('id') id: string) {
    return withMessage(
      await this.webhooks.rotateSecret(id),
      'New signing secret created — copy it now. Signatures made with the old one no longer verify.',
    );
  }

  /** A real, signed, logged delivery of the reserved `webhook.test` event. */
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async test(@Param('id') id: string) {
    return withMessage(await this.webhooks.sendTest(id), 'Test queued — watch the delivery log');
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.WEBHOOK_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(await this.webhooks.remove(id), 'Endpoint deleted');
  }
}
