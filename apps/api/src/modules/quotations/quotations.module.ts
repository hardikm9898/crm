import { Module } from '@nestjs/common';
import { DealsModule } from '../deals/deals.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { NumberSeriesController, QuotationsController } from './quotations.controller.js';
import { QuotationsService } from './quotations.service.js';
import { QuotationPdfService } from './quotation-pdf.service.js';
import { NumberSeriesService } from './number-series.service.js';
import { QuotationExpiryProcessor } from './quotations.processor.js';

/**
 * Quotations, their versions, their PDFs and the number series behind them.
 *
 * Imports `DealsModule` for one thing only — `LineBuilderService`, so a quotation's lines are priced
 * by the same code as a deal's — and `DocumentsModule` for the storage index a rendered PDF lives
 * in. It does **not** import `CustomFieldsModule`: a quotation has no custom fields, because the
 * fields that matter are on the deal and duplicating them onto the document would let the two
 * disagree.
 */
@Module({
  imports: [DealsModule, DocumentsModule],
  controllers: [QuotationsController, NumberSeriesController],
  providers: [
    QuotationsService,
    QuotationPdfService,
    NumberSeriesService,
    QuotationExpiryProcessor,
  ],
  exports: [QuotationsService, QuotationExpiryProcessor],
})
export class QuotationsModule {}
