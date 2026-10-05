import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  IMPORT_MODE_SPECS,
  importableFields,
  newId,
  parseCsv,
  proposeMapping,
  rowToRecord,
  sniffDelimiter,
  stripBom,
  tenantContext,
  validateMapping,
  type CsvDelimiter,
  type FieldError,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { EntitlementService } from '../../infra/entitlements/entitlement.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { ImportCatalogueService } from './import-catalogue.service.js';
import { mapImportRow } from './import-row-mapper.js';
import { createLeadSchema } from '../leads/leads.dto.js';
import type {
  ListImportRowsQuery,
  ListImportsQuery,
  PreviewImportQuery,
  SetImportMappingInput,
  UploadImportInput,
} from './imports.dto.js';

/**
 * The import wizard (`FR-IO-1`).
 *
 * Four steps, each a persisted state rather than a step in a client-side form:
 * `uploaded` → `mapped` → `validated` → `running`. That is the whole reason an `ImportJob` row
 * exists before anything is imported — a person who maps 40 columns of a 12 000-row file and then
 * closes the tab has not lost their work, and a support engineer can see exactly where a stuck
 * import stopped.
 *
 * The file is stored once, at upload, and re-read at each step. Re-reading is cheap compared with
 * keeping a 20 MB string in Redis for the duration of a wizard, and it means the preview a person
 * approves and the bytes the run processes are provably the same file.
 */

/** A hard cap, so one upload cannot become an hour of worker time. 50 000 rows is a big migration. */
const MAX_IMPORT_ROWS = 50_000;

/** How many rows the dry run reports individually before it stops listing and only counts. */
const MAX_REPORTED_PROBLEMS = 100;

@Injectable()
export class ImportsService {
  constructor(
    private readonly db: DbService,
    private readonly documents: DocumentsService,
    private readonly catalogues: ImportCatalogueService,
    private readonly entitlements: EntitlementService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The fields and modes the wizard offers, including this tenant's custom fields. */
  async catalogue() {
    const definitions = await this.catalogues.load();
    return {
      fields: fieldsFor(definitions),
      modes: Object.values(IMPORT_MODE_SPECS),
      maxRows: MAX_IMPORT_ROWS,
      maxBytes: this.config.UPLOAD_MAX_BYTES,
    };
  }

  /**
   * Step 1: take the file, propose a mapping, show it back.
   *
   * The proposal is the feature: a person uploading "Mobile No." and "E-mail ID" should not have to
   * tell the software what those are. It is only ever a proposal — nothing is imported until the
   * mapping is confirmed, which is also what makes a wrong guess harmless.
   */
  async upload(input: UploadImportInput, content: string) {
    const principal = tenantContext.require('imports.upload');
    const text = stripBom(content);
    if (text.trim() === '') {
      throw AppError.validation('That file is empty', [
        { field: 'file', code: 'EMPTY_FILE', message: 'The file has no rows.' },
      ]);
    }

    const delimiter: CsvDelimiter = input.delimiter ?? sniffDelimiter(text);
    const table = parseCsv(text, { delimiter, maxRows: MAX_IMPORT_ROWS + 1 });
    if (table.header.length === 0 || table.header.every((column) => column.trim() === '')) {
      throw AppError.validation('That file has no column headings', [
        {
          field: 'file',
          code: 'NO_HEADER',
          message: 'The first row must name the columns, for example “Name, Phone, Email”.',
        },
      ]);
    }
    if (table.rows.length === 0) {
      throw AppError.validation('That file has headings but no rows', [
        { field: 'file', code: 'NO_ROWS', message: 'There is nothing below the heading row.' },
      ]);
    }
    if (table.rows.length > MAX_IMPORT_ROWS) {
      throw AppError.validation(`That file has more than ${MAX_IMPORT_ROWS} rows`, [
        {
          field: 'file',
          code: 'TOO_MANY_ROWS',
          message: `Please split it into files of up to ${MAX_IMPORT_ROWS} rows.`,
        },
      ]);
    }

    const document = await this.documents.store({
      subject: 'import',
      fileName: input.fileName,
      mimeType: 'text/csv',
      body: Buffer.from(content, 'utf8'),
      // The source file outlives the run by a month: re-checking what was actually uploaded is the
      // first thing anybody asks when an import looks wrong.
      expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
    });

    const catalogue = await this.catalogues.load();
    const proposal = proposeMapping(table.header, fieldsFor(catalogue));

    const id = newId();
    await this.db.client.importJob.create({
      data: {
        id,
        organizationId: principal.organizationId,
        documentId: document.id,
        entityType: input.entityType,
        status: 'uploaded',
        mapping: proposal.mapping as never,
        delimiter,
        totalRows: table.rows.length,
        requestedById: principal.actorId ?? null,
      },
    });

    await this.audit.record({
      action: 'import.uploaded',
      resourceType: 'import_job',
      resourceId: id,
      after: { fileName: input.fileName, rows: table.rows.length, delimiter },
    });

    return {
      id,
      status: 'uploaded',
      fileName: document.fileName,
      sizeBytes: document.sizeBytes,
      delimiter,
      totalRows: table.rows.length,
      header: table.header,
      /** The proposal, which the wizard shows as pre-selected and the person can change. */
      mapping: proposal.mapping,
      unmatched: proposal.unmatched,
      ambiguous: proposal.ambiguous,
      sample: table.rows.slice(0, 10).map((cells) => rowToRecord(table.header, cells)),
    };
  }

  /** Step 2: the person's mapping, checked before it is saved. */
  async setMapping(id: string, input: SetImportMappingInput) {
    const job = await this.load(id);
    this.assertNotRunning(job.status);

    const table = await this.readTable(job.documentId, job.delimiter);
    const catalogue = await this.catalogues.load();
    const problems = validateMapping(input.mapping, table.header, fieldsFor(catalogue));
    if (problems.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That mapping cannot be used yet',
        422,
        problems.map((problem) => ({
          field: problem.header ?? problem.field ?? 'mapping',
          code: problem.code,
          message: problem.message,
        })),
      );
    }

    await this.db.client.importJob.update({
      where: { id },
      data: { mapping: input.mapping as never, mode: input.mode, status: 'mapped' },
    });
    return this.get(id);
  }

  /**
   * Step 3: the dry run.
   *
   * It maps every row and validates it against the *lead schema itself*, writing nothing. The point
   * is that a person finds out about 400 bad phone numbers before the import, not after — and that
   * what the dry run accepts is what the run accepts, because both go through the same mapper and
   * the same schema.
   *
   * What it cannot know is what a duplicate rule will decide, because that depends on the leads that
   * exist at the moment the row is processed — including the ones earlier rows of this same file
   * created. Saying so is better than pretending.
   */
  async validate(id: string) {
    const report = await this.check(id);
    await this.db.client.importJob.update({ where: { id }, data: { status: 'validated' } });
    return { ...report, status: 'validated' };
  }

  /**
   * The dry run itself, writing nothing at all.
   *
   * Separate from `validate` because a *page* has to be able to show this report, and rendering a
   * screen must never run a mutation: a wizard that re-ran its own state transition on every
   * refresh would be a state machine driven by the browser's reload button. `GET /imports/:id/check`
   * reads, `POST /imports/:id/validate` is the step a person takes.
   */
  async check(id: string) {
    const job = await this.load(id);
    this.assertNotRunning(job.status);
    if (Object.keys(job.mapping as object).length === 0) {
      throw AppError.businessRule('Choose which columns to import first.');
    }

    const table = await this.readTable(job.documentId, job.delimiter);
    const catalogue = await this.catalogues.load();
    const mapping = job.mapping as Record<string, string>;

    const problems: { row: number; errors: readonly FieldError[] }[] = [];
    let valid = 0;
    let blank = 0;
    let invalid = 0;
    for (const [index, cells] of table.rows.entries()) {
      const mapped = mapImportRow(rowToRecord(table.header, cells), { mapping, catalogue });
      if (mapped.isBlank) {
        blank += 1;
        continue;
      }
      const errors: FieldError[] = [...mapped.errors];
      if (errors.length === 0) {
        const parsed = createLeadSchema.safeParse({
          ...mapped.draft,
          ...(Object.keys(mapped.customValues).length > 0
            ? { customValues: mapped.customValues }
            : {}),
          createdVia: 'import',
        });
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            errors.push({
              field: issue.path.map(String).join('.') || 'row',
              code: issue.code.toUpperCase(),
              message: issue.message,
            });
          }
        }
      }
      if (errors.length === 0) {
        valid += 1;
        continue;
      }
      invalid += 1;
      // Only the first hundred are kept: a person fixing a broken file needs those, and holding
      // nine thousand error lists in memory to then throw them away is how a dry run runs out of it.
      if (problems.length < MAX_REPORTED_PROBLEMS) problems.push({ row: index + 2, errors });
    }
    return {
      id,
      status: job.status,
      mode: job.mode,
      totalRows: table.rows.length,
      valid,
      invalid,
      blank,
      problems,
      problemsTruncated: invalid > MAX_REPORTED_PROBLEMS,
      warnings: await this.warningsFor(valid),
    };
  }

  /** Step 4: hand it to the queue. */
  async start(id: string) {
    const job = await this.load(id);
    if (job.status === 'running' || job.status === 'queued') {
      throw AppError.conflict('This import is already running.');
    }
    if (job.status === 'completed') {
      throw AppError.conflict(
        'This import has already finished. Upload the file again to re-run it.',
      );
    }
    if (Object.keys(job.mapping as object).length === 0) {
      throw AppError.businessRule('Choose which columns to import first.');
    }

    await this.db.client.importJob.update({
      where: { id },
      data: { status: 'queued', error: null },
    });
    await this.queue.enqueue(
      QUEUES.IMPORTS_EXPORTS,
      JOBS.IMPORT_PROCESS,
      { organizationId: job.organizationId, importJobId: id, aggregateId: id },
      // The job id is the import's own id, so pressing Start twice cannot run the file twice.
      { jobId: `import-${id}` },
    );

    await this.audit.record({
      action: 'import.started',
      resourceType: 'import_job',
      resourceId: id,
      after: { mode: job.mode, totalRows: job.totalRows },
    });
    this.logger.info({ importJobId: id, mode: job.mode }, 'import queued');
    return this.get(id);
  }

  /**
   * Stops a run at the next row boundary.
   *
   * Not a rollback: the leads already created are real, and silently deleting a person's first
   * 900 leads because they pressed Cancel would be far worse than leaving them. The row records say
   * exactly which ones they are.
   */
  async cancel(id: string) {
    const job = await this.load(id);
    if (job.status === 'completed' || job.status === 'cancelled') return this.get(id);
    await this.db.client.importJob.update({
      where: { id },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    await this.audit.record({
      action: 'import.cancelled',
      resourceType: 'import_job',
      resourceId: id,
      after: { processedRows: job.processedRows },
    });
    return this.get(id);
  }

  async list(query: ListImportsQuery) {
    const where = { ...(query.status ? { status: query.status } : {}) };
    const rows = await this.db.client.importJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { document: { select: { fileName: true, sizeBytes: true } } },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => this.summarize(row)),
      pagination: {
        limit: query.limit,
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        hasMore: rows.length > query.limit,
      },
    };
  }

  async get(id: string) {
    const job = await this.db.client.importJob.findFirst({
      where: { id },
      include: { document: { select: { fileName: true, sizeBytes: true } } },
    });
    if (!job) throw AppError.notFound('Import');
    return this.summarize(job);
  }

  /** The file as it will be read, for the mapping screen. */
  async preview(id: string, query: PreviewImportQuery) {
    const job = await this.load(id);
    const table = await this.readTable(job.documentId, job.delimiter);
    const catalogue = await this.catalogues.load();
    const fields = fieldsFor(catalogue);
    const mapping = job.mapping as Record<string, string>;
    const proposal = proposeMapping(table.header, fields);

    return {
      id,
      status: job.status,
      mode: job.mode,
      delimiter: job.delimiter,
      header: table.header,
      totalRows: table.rows.length,
      mapping: Object.keys(mapping).length > 0 ? mapping : proposal.mapping,
      unmatched: proposal.unmatched,
      ambiguous: proposal.ambiguous,
      fields,
      modes: Object.values(IMPORT_MODE_SPECS),
      sample: table.rows.slice(0, query.rows).map((cells) => rowToRecord(table.header, cells)),
    };
  }

  async rows(id: string, query: ListImportRowsQuery) {
    await this.load(id);
    const rows = await this.db.client.importRow.findMany({
      where: {
        jobId: id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.after ? { rowNumber: { gt: query.after } } : {}),
      },
      orderBy: { rowNumber: 'asc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        rowNumber: row.rowNumber,
        status: row.status,
        errors: row.errors as unknown as FieldError[],
        leadId: row.leadId,
        raw: row.raw as Record<string, string>,
      })),
      pagination: {
        limit: query.limit,
        nextCursor: rows.length > query.limit ? String(page.at(-1)?.rowNumber ?? '') : null,
        hasMore: rows.length > query.limit,
      },
    };
  }

  /** The failed-rows file, for `GET /imports/:id/errors.csv`. */
  async errorFile(id: string): Promise<{ fileName: string; body: Buffer }> {
    const job = await this.load(id);
    if (!job.errorDocumentId) {
      throw AppError.notFound('Error file');
    }
    const { document, body } = await this.documents.read(job.errorDocumentId);
    return { fileName: document.fileName, body };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async load(id: string) {
    const job = await this.db.client.importJob.findFirst({ where: { id } });
    if (!job) throw AppError.notFound('Import');
    return job;
  }

  private assertNotRunning(status: string): void {
    if (status === 'running' || status === 'queued') {
      throw AppError.conflict('This import is running. Cancel it first to change anything.');
    }
  }

  private async readTable(documentId: string, delimiter: string) {
    const { body } = await this.documents.read(documentId);
    return parseCsv(stripBom(body.toString('utf8')), {
      delimiter: delimiter as CsvDelimiter,
      maxRows: MAX_IMPORT_ROWS + 1,
    });
  }

  /**
   * Things that are not errors but that a person should know before pressing Start — most
   * importantly that their plan's lead limit will stop the import part-way.
   */
  private async warningsFor(valid: number): Promise<string[]> {
    const warnings: string[] = [];
    const used = await this.db.client.lead.count({ where: { deletedAt: null } });
    const entitlement = await this.entitlements.get('leads');
    if (entitlement.limit !== null && used + valid > entitlement.limit) {
      const room = Math.max(entitlement.limit - used, 0);
      warnings.push(
        `Your plan allows ${entitlement.limit} leads and you have ${used}. ` +
          `Only about ${room} of these rows will import before the limit is reached.`,
      );
    }
    warnings.push(
      'Duplicates are decided when each row is processed, using your duplicate rules, so the ' +
        'final counts may differ from this check.',
    );
    return warnings;
  }

  private summarize(job: {
    id: string;
    status: string;
    mode: string;
    delimiter: string;
    entityType: string;
    mapping: unknown;
    totalRows: number;
    processedRows: number;
    createdCount: number;
    updatedCount: number;
    attachedCount: number;
    skippedCount: number;
    failedCount: number;
    error: string | null;
    errorDocumentId: string | null;
    requestedById: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
    document?: { fileName: string; sizeBytes: number };
  }) {
    return {
      id: job.id,
      status: job.status,
      mode: job.mode,
      entityType: job.entityType,
      delimiter: job.delimiter,
      mapping: job.mapping as Record<string, string>,
      fileName: job.document?.fileName ?? null,
      sizeBytes: job.document?.sizeBytes ?? null,
      totals: {
        rows: job.totalRows,
        processed: job.processedRows,
        created: job.createdCount,
        updated: job.updatedCount,
        attached: job.attachedCount,
        skipped: job.skippedCount,
        failed: job.failedCount,
      },
      error: job.error,
      hasErrorFile: job.errorDocumentId !== null,
      requestedById: job.requestedById,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      createdAt: job.createdAt,
    };
  }
}

/**
 * The importable fields for this tenant: the built-in lead fields plus `custom.<key>` for every
 * active custom field. Needed by four of the methods above, which is why it is not inlined.
 */
function fieldsFor(catalogue: {
  customFields: readonly { key: string; label: string; type: string }[];
}) {
  return importableFields(
    catalogue.customFields.map((definition) => ({
      key: definition.key,
      label: definition.label,
      type: definition.type,
    })),
  );
}
