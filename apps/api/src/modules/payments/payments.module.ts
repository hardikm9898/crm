import { Module } from '@nestjs/common';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { PaymentMethodsController, PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PaymentMethodsService } from './payment-methods.service.js';
import { PaymentRollupsService } from './payment-rollups.service.js';

/**
 * The payments ledger, the methods a workspace accepts, and the figures derived from both.
 *
 * Imports `QuotationsModule` for `NumberSeriesService` only — a receipt number comes from the same
 * locked-counter machinery as a quotation number, under its own `kind`. It reads deals, quotations,
 * leads and customers directly rather than through their modules: a payment needs a party's branch,
 * team and owner to inherit ownership, and importing four modules to read three columns each would
 * couple the ledger to the whole of the CRM surface.
 */
@Module({
  imports: [QuotationsModule],
  controllers: [PaymentsController, PaymentMethodsController],
  providers: [PaymentsService, PaymentMethodsService, PaymentRollupsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
