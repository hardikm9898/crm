import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { PaymentsService } from './payments.service.js';
import { PaymentMethodsService } from './payment-methods.service.js';
import {
  confirmPaymentSchema,
  createPaymentMethodSchema,
  failPaymentSchema,
  listPaymentsSchema,
  recordPaymentSchema,
  refundPaymentSchema,
  updatePaymentMethodSchema,
  updatePaymentSchema,
  type ConfirmPaymentInput,
  type CreatePaymentMethodInput,
  type FailPaymentInput,
  type ListPaymentsQuery,
  type RefundPaymentInput,
  type UpdatePaymentInput,
  type UpdatePaymentMethodInput,
} from './payments.dto.js';

/**
 * Payments (`FR-DEAL-3`).
 *
 * `payment:read` and `payment:record`, separate from `deal:*` on purpose: quoting a price and
 * recording that money arrived are different acts, done by different people in most businesses.
 *
 * Confirm, fail and refund are their own endpoints rather than a `status` field on the PATCH,
 * because each has its own preconditions, its own timeline entry on two subjects, its own event and
 * its own effect on the rollups — and a PATCH that happened to carry `status` could check none of
 * them. `PATCH` is for correcting a figure somebody typed wrong.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  async list(@Query(new ZodBody(listPaymentsSchema)) query: ListPaymentsQuery) {
    return this.payments.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.PAYMENT_RECORD)
  async record(@Body(zodBody(recordPaymentSchema)) body: unknown) {
    const payment = await this.payments.record(body as never);
    return withMessage(payment, `Payment ${payment.number} recorded`);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  async findOne(@Param('id') id: string) {
    return this.payments.findOne(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.PAYMENT_RECORD)
  async update(@Param('id') id: string, @Body(zodBody(updatePaymentSchema)) body: unknown) {
    return withMessage(
      await this.payments.update(id, body as UpdatePaymentInput),
      'Payment corrected',
    );
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.PAYMENT_RECORD)
  async confirm(@Param('id') id: string, @Body(zodBody(confirmPaymentSchema)) body: unknown) {
    return withMessage(
      await this.payments.confirm(id, body as ConfirmPaymentInput),
      'Payment confirmed',
    );
  }

  @Post(':id/fail')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.PAYMENT_RECORD)
  async fail(@Param('id') id: string, @Body(zodBody(failPaymentSchema)) body: unknown) {
    return withMessage(
      await this.payments.fail(id, body as FailPaymentInput),
      'Payment marked failed',
    );
  }

  @Post(':id/refund')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.PAYMENT_RECORD)
  async refund(@Param('id') id: string, @Body(zodBody(refundPaymentSchema)) body: unknown) {
    return withMessage(
      await this.payments.refund(id, body as RefundPaymentInput),
      'Payment refunded',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.PAYMENT_RECORD)
  async remove(@Param('id') id: string) {
    return withMessage(await this.payments.remove(id), 'Payment deleted');
  }
}

/**
 * How money arrives, as the tenant's own list.
 *
 * Readable with `payment:read` so a form can offer the dropdown, writable with `settings:manage`
 * like every other piece of workspace configuration.
 */
@Controller('settings/payment-methods')
export class PaymentMethodsController {
  constructor(private readonly methods: PaymentMethodsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.PAYMENT_READ)
  async list(@Query('includeInactive') includeInactive?: string) {
    return this.methods.list(includeInactive === 'true');
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async create(@Body(zodBody(createPaymentMethodSchema)) body: unknown) {
    return withMessage(
      await this.methods.create(body as CreatePaymentMethodInput),
      'Payment method added',
    );
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async update(@Param('id') id: string, @Body(zodBody(updatePaymentMethodSchema)) body: unknown) {
    return withMessage(
      await this.methods.update(id, body as UpdatePaymentMethodInput),
      'Payment method saved',
    );
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  async remove(@Param('id') id: string) {
    return withMessage(await this.methods.remove(id), 'Payment method removed');
  }
}
