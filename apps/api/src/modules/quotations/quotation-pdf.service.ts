import { Inject, Injectable } from '@nestjs/common';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { AppError, formatMoney, money, tenantContext } from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { DocumentsService } from '../documents/documents.service.js';

const require = createRequire(import.meta.url);

/**
 * The font the documents are set in.
 *
 * **Not a built-in.** PDF's standard fourteen fonts are WinAnsi-encoded and have no `₹` — a
 * quotation for an Indian business printed in Helvetica says `1,18,000.00` with a box where the
 * currency should be, or silently drops the character. DejaVu Sans is a declared dependency
 * (`dejavu-fonts-ttf`, Bitstream Vera licence, redistributable) rather than a file read from
 * `/usr/share/fonts`, because a container without that path would render every quotation in the
 * product unreadable and nothing would fail until somebody opened one.
 *
 * Its coverage is Latin, the rupee sign and ordinary punctuation. **It has no Devanagari, Gujarati
 * or Tamil glyphs**, so a name written in an Indic script prints as empty boxes; `unsupported()`
 * finds those characters so the failure is logged rather than discovered by a customer. Per-script
 * font fallback is a renderer change, not a font swap, and is deferred deliberately.
 */
const FONT_REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const PAGE_MARGIN = 48;
const COLUMN = { name: 48, qty: 300, price: 360, tax: 440, total: 490 } as const;

export interface RenderedPdf {
  readonly fileName: string;
  readonly mimeType: string;
  readonly body: Buffer;
}

/**
 * Rendering a quotation as the document a customer receives (`FR-DEAL-2`).
 *
 * **Synchronous, not a queue job.** The architecture sketch put `pdf.quotation` in a background
 * queue; one page of a dozen lines renders in milliseconds, and a queued render would mean a
 * download button that says "come back in a moment" for no benefit, plus a polling UI and a job
 * state machine to go with it. `docs/queue-event-architecture.md` is amended to match, and the
 * reasoning is in
 * [ADR-0019](../../../../../docs/decisions/ADR-0019-quotation-versions-are-immutable.md).
 *
 * **Cached per version, because a version is immutable.** Once sent, a quotation's lines and totals
 * can never change — a revision is a new row — so the bytes are stored once as a `documents` row and
 * handed out from there. A draft is rendered fresh every time and never stored: the database refuses
 * a draft with a `pdf_document_id` for the same reason (`quotations_pdf_needs_sending`), because a
 * file of a document that is still being written is a file somebody will send by mistake.
 */
@Injectable()
export class QuotationPdfService {
  constructor(
    private readonly db: DbService,
    private readonly documents: DocumentsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async forQuotation(id: string): Promise<RenderedPdf> {
    const quotation = await this.load(id);

    if (quotation.pdfDocumentId) {
      const cached = await this.documents.read(quotation.pdfDocumentId);
      return {
        fileName: cached.document.fileName,
        mimeType: cached.document.mimeType,
        body: cached.body,
      };
    }

    const rendered = await this.render(quotation);
    if (quotation.status === 'draft') return rendered;

    // A frozen version's bytes are worth keeping: the same request will be made again by the
    // customer's reply, the accountant and the dispute.
    const stored = await this.documents.store({
      subject: 'quotation',
      fileName: rendered.fileName,
      mimeType: rendered.mimeType,
      body: rendered.body,
      // No expiry. An export is a convenience that goes stale; a quotation is a record.
      expiresAt: null,
    });
    await this.db.client.quotation.update({
      where: { id },
      data: { pdfDocumentId: stored.id },
    });
    return rendered;
  }

  private async load(id: string) {
    const row = await this.db.client.quotation.findFirst({
      where: { id },
      include: {
        items: { orderBy: { position: 'asc' } },
        lead: { select: { fullName: true, phoneE164: true, email: true, company: true } },
        customer: {
          select: {
            fullName: true,
            phoneE164: true,
            email: true,
            company: true,
            billingLine1: true,
            billingLine2: true,
            city: true,
            state: true,
            postalCode: true,
            country: true,
          },
        },
      },
    });
    if (!row) throw AppError.notFound('Quotation');
    return row;
  }

  private async render(quotation: Awaited<ReturnType<QuotationPdfService['load']>>) {
    const principal = tenantContext.require('quotations.pdf');
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: principal.organizationId },
      select: { name: true, timezone: true },
    });

    const currency = quotation.currency;
    const amount = (minor: bigint | number) => formatMoney(money(Number(minor), currency));
    const party = quotation.customer ?? quotation.lead;

    const unsupported = this.unsupported([
      organization.name,
      party?.fullName ?? '',
      party?.company ?? '',
      quotation.title ?? '',
      quotation.terms ?? '',
      ...quotation.items.map((item) => `${item.name} ${item.description ?? ''}`),
    ]);
    if (unsupported.length > 0) {
      // Visible in the log rather than only in the file, because the person who notices the empty
      // boxes is the customer.
      this.logger.warn(
        { quotationId: quotation.id, codePoints: unsupported },
        'quotation PDF contains characters the document font cannot render',
      );
    }

    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    doc.registerFont('body', FONT_REGULAR);
    doc.registerFont('bold', FONT_BOLD);
    doc.font('body').fontSize(10);

    // ── Header ──────────────────────────────────────────────────────────────
    doc.font('bold').fontSize(16).text(organization.name);
    doc.font('body').fontSize(9).fillColor('#555555');
    doc.text('Quotation');
    doc.fillColor('#000000').moveDown(0.8);

    const headerTop = doc.y;
    doc.font('bold').fontSize(12).text(quotation.number, PAGE_MARGIN, headerTop);
    if (quotation.version > 1) {
      doc.font('body').fontSize(9).text(`Revision ${quotation.version}`);
    }
    doc.font('body').fontSize(9);
    doc.text(`Raised ${this.day(quotation.createdAt, organization.timezone)}`);
    if (quotation.validUntil) {
      doc.text(`Valid until ${this.day(quotation.validUntil, organization.timezone)}`);
    }
    if (quotation.status !== 'draft' && quotation.sentAt) {
      doc.text(`Sent ${this.day(quotation.sentAt, organization.timezone)}`);
    }
    if (quotation.status === 'draft') {
      doc.font('bold').fillColor('#b45309').text('DRAFT — not yet sent').fillColor('#000000');
    }

    // The party, to the right of the same block.
    doc.font('bold').fontSize(10).text('For', 330, headerTop);
    doc.font('body').fontSize(9);
    doc.text(party?.fullName ?? '—', 330, doc.y, { width: 220 });
    if (party?.company) doc.text(party.company, 330, doc.y, { width: 220 });
    for (const line of this.addressLines(quotation.customer)) {
      doc.text(line, 330, doc.y, { width: 220 });
    }
    if (party?.phoneE164) doc.text(party.phoneE164, 330, doc.y, { width: 220 });
    if (party?.email) doc.text(party.email, 330, doc.y, { width: 220 });

    doc.moveDown(2);
    if (quotation.title) {
      doc.font('bold').fontSize(11).text(quotation.title, PAGE_MARGIN, doc.y);
      doc.moveDown(0.5);
    }

    // ── Lines ───────────────────────────────────────────────────────────────
    let y = Math.max(doc.y, headerTop + 110);
    doc.font('bold').fontSize(9);
    doc.text('Item', COLUMN.name, y);
    doc.text('Qty', COLUMN.qty, y, { width: 50, align: 'right' });
    doc.text('Price', COLUMN.price, y, { width: 70, align: 'right' });
    doc.text('Tax', COLUMN.tax, y, { width: 40, align: 'right' });
    doc.text('Total', COLUMN.total, y, { width: 60, align: 'right' });
    y += 14;
    doc
      .moveTo(PAGE_MARGIN, y - 3)
      .lineTo(550, y - 3)
      .strokeColor('#cccccc')
      .stroke();

    doc.font('body').fontSize(9);
    for (const item of quotation.items) {
      if (y > 700) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      const nameHeight = doc.heightOfString(item.name, { width: 240 });
      doc.text(item.name, COLUMN.name, y, { width: 240 });
      doc.text(this.quantity(item.quantity), COLUMN.qty, y, { width: 50, align: 'right' });
      doc.text(amount(item.unitPriceMinor), COLUMN.price, y, { width: 70, align: 'right' });
      doc.text(`${this.percent(item.taxPercent)}%`, COLUMN.tax, y, { width: 40, align: 'right' });
      doc.text(amount(item.totalMinor), COLUMN.total, y, { width: 60, align: 'right' });
      y += nameHeight + 2;
      if (item.description) {
        doc.fillColor('#555555');
        const descriptionHeight = doc.heightOfString(item.description, { width: 240 });
        doc.text(item.description, COLUMN.name, y, { width: 240 });
        doc.fillColor('#000000');
        y += descriptionHeight + 2;
      }
      if (Number(item.discountMinor) > 0) {
        doc.fillColor('#555555');
        doc.text(`less ${amount(item.discountMinor)} discount`, COLUMN.name, y, { width: 240 });
        doc.fillColor('#000000');
        y += 11;
      }
      y += 4;
    }

    // ── Totals ──────────────────────────────────────────────────────────────
    y += 6;
    doc.moveTo(330, y).lineTo(550, y).strokeColor('#cccccc').stroke();
    y += 6;
    const totalRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'bold' : 'body').fontSize(bold ? 11 : 9);
      doc.text(label, 330, y, { width: 120 });
      doc.text(value, 450, y, { width: 100, align: 'right' });
      y += bold ? 16 : 13;
    };
    totalRow('Subtotal', amount(quotation.grossMinor));
    if (Number(quotation.discountMinor) > 0) {
      totalRow('Discount', `- ${amount(quotation.discountMinor)}`);
    }
    for (const line of this.taxLines(quotation.items)) {
      totalRow(`Tax at ${line.percent}%`, amount(line.taxMinor));
    }
    totalRow('Total', amount(quotation.totalMinor), true);

    // ── Terms ───────────────────────────────────────────────────────────────
    if (quotation.terms) {
      y += 14;
      if (y > 680) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      doc.font('bold').fontSize(9).text('Terms', PAGE_MARGIN, y);
      doc
        .font('body')
        .fontSize(8)
        .fillColor('#333333')
        .text(quotation.terms, PAGE_MARGIN, doc.y, { width: 500 })
        .fillColor('#000000');
    }

    const body = await this.finish(doc);
    return {
      fileName: `${quotation.number.replace(/[^A-Za-z0-9._-]/g, '-')}${
        quotation.version > 1 ? `-v${quotation.version}` : ''
      }.pdf`,
      mimeType: 'application/pdf',
      body,
    };
  }

  /** The per-rate tax breakdown, recomputed from the stored lines rather than from a column. */
  private taxLines(
    items: readonly { taxPercent: unknown; taxMinor: bigint }[],
  ): { percent: string; taxMinor: number }[] {
    const byRate = new Map<number, number>();
    for (const item of items) {
      const percent = Number(item.taxPercent);
      byRate.set(percent, (byRate.get(percent) ?? 0) + Number(item.taxMinor));
    }
    return [...byRate.entries()]
      .filter(([, amount]) => amount !== 0)
      .sort((a, b) => a[0] - b[0])
      .map(([percent, taxMinor]) => ({ percent: this.percent(percent), taxMinor }));
  }

  private addressLines(
    customer: {
      billingLine1: string | null;
      billingLine2: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
      country: string | null;
    } | null,
  ): string[] {
    if (!customer) return [];
    const locality = [customer.city, customer.state, customer.postalCode]
      .filter((part): part is string => Boolean(part))
      .join(' ');
    return [customer.billingLine1, customer.billingLine2, locality, customer.country].filter(
      (line): line is string => Boolean(line && line.trim()),
    );
  }

  /** `2.5`, not `2.500` — trailing zeros on a quantity read like a rounding error. */
  private quantity(value: unknown): string {
    return String(Number(value));
  }

  private percent(value: unknown): string {
    return String(Number(value));
  }

  /** The workspace's day, not UTC's: a quotation dated "yesterday" is a support call. */
  private day(value: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: timezone,
    }).format(value);
  }

  /** Code points the document font has no glyph for, as `U+0915` strings. */
  private unsupported(texts: readonly string[]): string[] {
    const found = new Set<string>();
    for (const text of texts) {
      for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        // Latin-1 plus the punctuation and currency blocks DejaVu certainly covers; anything above
        // is checked against the ranges the font does not have.
        if (code < 0x0250 || (code >= 0x2000 && code <= 0x20cf)) continue;
        found.add(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
    return [...found].slice(0, 20);
  }

  private finish(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }
}
