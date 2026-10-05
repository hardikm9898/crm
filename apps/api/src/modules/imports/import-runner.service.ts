import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVITY_TYPES,
  AppError,
  newId,
  normalizePhone,
  parseCsv,
  rowToRecord,
  tenantContext,
  withPlatformScope,
  writeCsv,
  type CountryCode,
  type CsvDelimiter,
  type FieldError,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { TimelineService } from '../../infra/timeline/timeline.service.js';
import { PrincipalService } from '../auth/application/principal.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { DuplicateDetectionService } from '../duplicates/duplicate-detection.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { createLeadSchema, updateLeadSchema } from '../leads/leads.dto.js';
import { ImportCatalogueService, type ImportCatalogue } from './import-catalogue.service.js';
import { mapImportRow, type MappedImportRow } from './import-row-mapper.js';

/**
 * Running an import.
 *
 * The three decisions that shape this file:
 *
 *  1. **A row is a record, not a log line.** Every row of the file gets an `import_rows` row saying
 *     what became of it — created, updated, attached, skipped or failed, with the cells as they
 *     arrived. That is what makes "where did this lead come from" answerable six months later, what
 *     lets the error file reproduce a row exactly, and what makes a retry resumable: the rows
 *     already recorded are the rows already done.
 *  2. **Leads are created through `LeadsService`, never written directly.** An imported lead must be
 *     indistinguishable from a manually created one: the same duplicate rules, the same assignment
 *     engine, the same timeline entry, the same outbox event, the same custom-field validation.
 *     Writing rows here would be faster and would quietly produce leads nobody is assigned to and
 *     nothing reacted to (`FR-IO-2`: an import must never blind-create).
 *  3. **The run acts as the person who asked for it.** Not as a system principal: their data scope
 *     decides which leads they may update, and the audit trail has to name them. If their access
 *     was revoked between pressing Import and the worker picking the job up, the run fails saying
 *     so, which is the correct answer rather than importing on the authority of nobody.
 */

/** How often the job's counters are flushed, so a person watching the progress bar sees movement. */
const PROGRESS_EVERY = 25;

/** What became of a row. `failed` is deliberately separate: it is the only one carrying errors. */
type RowOutcome = 'created' | 'updated' | 'attached' | 'skipped';

interface RunCounters {
  processed: number;
  created: number;
  updated: number;
  attached: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class ImportRunnerService {
  constructor(
    private readonly db: DbService,
    private readonly catalogues: ImportCatalogueService,
    private readonly documents: DocumentsService,
    private readonly leads: LeadsService,
    private readonly duplicates: DuplicateDetectionService,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Processes one import job, from wherever it left off.
   *
   * Called from the queue, so it opens its own tenant context — the job carries an organization id
   * and a requester, and nothing else about the original request survives.
   */
  async run(organizationId: string, jobId: string): Promise<void> {
    const job = await withPlatformScope('imports: load job for run', async () =>
      this.db.client.importJob.findFirst({ where: { id: jobId, organizationId } }),
    );
    if (!job) {
      this.logger.error({ jobId, organizationId }, 'import job not found');
      return;
    }
    if (job.status === 'completed' || job.status === 'cancelled') {
      // A duplicate delivery of a finished job. Not an error: at-least-once means this is expected.
      return;
    }
    if (!job.requestedById) {
      await this.failRun(organizationId, jobId, 'This import has no requester and cannot be run.');
      return;
    }

    let principal;
    try {
      principal = await this.principals.build({
        userId: job.requestedById,
        organizationId,
        // There is no session behind a background run; the job id is what the audit trail and the
        // logs should correlate on.
        sessionId: jobId,
        requestId: `import-${jobId}`,
      });
    } catch (error) {
      await this.failRun(
        organizationId,
        jobId,
        'The person who started this import no longer has access to this workspace.',
      );
      this.logger.warn({ jobId, error }, 'import requester can no longer be resolved');
      return;
    }

    await tenantContext.run(principal, async () => {
      await this.execute(jobId);
    });
  }

  private async execute(jobId: string): Promise<void> {
    const job = await this.db.client.importJob.findFirstOrThrow({ where: { id: jobId } });
    const { body } = await this.documents.read(job.documentId);
    const table = parseCsv(body.toString('utf8'), { delimiter: job.delimiter as CsvDelimiter });
    const mapping = job.mapping as Record<string, string>;
    const catalogue = await this.catalogues.load();

    // Resuming: the rows already recorded are the rows already done, and the counters are derived
    // from them rather than trusted from the job — a crash between "write row" and "update counts"
    // must not leave the two disagreeing (the database refuses that anyway:
    // `import_jobs_outcomes_account_for_processed`).
    const done = await this.db.client.importRow.findMany({
      where: { jobId },
      select: { rowNumber: true, status: true },
    });
    const alreadyDone = new Set(done.map((row) => row.rowNumber));
    const counters: RunCounters = {
      processed: done.length,
      created: done.filter((row) => row.status === 'created').length,
      updated: done.filter((row) => row.status === 'updated').length,
      attached: done.filter((row) => row.status === 'attached').length,
      skipped: done.filter((row) => row.status === 'skipped').length,
      failed: done.filter((row) => row.status === 'failed').length,
    };

    await this.db.client.importJob.update({
      where: { id: jobId },
      data: {
        status: 'running',
        startedAt: job.startedAt ?? new Date(),
        totalRows: table.rows.length,
        error: null,
      },
    });

    for (const [index, cells] of table.rows.entries()) {
      // Row 1 is the header, so the first data row is row 2 — the number the person's own
      // spreadsheet shows them, which is the only number worth reporting.
      const rowNumber = index + 2;
      if (alreadyDone.has(rowNumber)) continue;

      const record = rowToRecord(table.header, cells);
      const outcome = await this.processRow({
        jobId,
        rowNumber,
        record,
        mapping,
        mode: job.mode,
        catalogue,
      });

      counters.processed += 1;
      counters[outcome.status] += 1;
      if (counters.processed % PROGRESS_EVERY === 0) await this.flush(jobId, counters);

      // A cancellation mid-run stops at the next row boundary, leaving every finished row intact.
      if (counters.processed % PROGRESS_EVERY === 0 && (await this.isCancelled(jobId))) {
        await this.flush(jobId, counters);
        return;
      }
    }

    await this.flush(jobId, counters);
    const errorDocumentId = await this.writeErrorFile(jobId, table.header, job.delimiter);

    await this.db.client.importJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        ...(errorDocumentId ? { errorDocumentId } : {}),
      },
    });

    await this.audit.record({
      action: 'lead.imported',
      resourceType: 'import_job',
      resourceId: jobId,
      after: {
        mode: job.mode,
        totalRows: table.rows.length,
        created: counters.created,
        updated: counters.updated,
        attached: counters.attached,
        skipped: counters.skipped,
        failed: counters.failed,
      },
    });

    this.logger.info({ jobId, ...counters }, 'import finished');
  }

  /**
   * One row.
   *
   * Never throws: a row that cannot be imported is a recorded failure, because the alternative is a
   * run that stops at row 1 400 of 5 000 and leaves a person guessing. Only a fault that makes the
   * *whole* run impossible — the file unreadable, the requester gone — fails the job.
   */
  private async processRow(input: {
    jobId: string;
    rowNumber: number;
    record: Record<string, string>;
    mapping: Record<string, string>;
    mode: string;
    catalogue: ImportCatalogue;
  }): Promise<{ status: RowOutcome | 'failed' }> {
    const mapped = mapImportRow(input.record, {
      mapping: input.mapping,
      catalogue: input.catalogue,
    });

    if (mapped.isBlank) {
      await this.recordRow(input, 'skipped', [], null);
      return { status: 'skipped' };
    }
    if (mapped.errors.length > 0) {
      await this.recordRow(input, 'failed', mapped.errors, null);
      return { status: 'failed' };
    }

    try {
      const outcome = await this.applyRow(mapped, input.mode, input.catalogue);
      await this.recordRow(input, outcome.status, [], outcome.leadId);
      return { status: outcome.status };
    } catch (error) {
      const errors = fieldErrorsFrom(error);
      await this.recordRow(input, 'failed', errors, null);
      return { status: 'failed' };
    }
  }

  /**
   * The mode's actual behaviour (`FR-IO-2`).
   *
   * `create_only` hands the row to `LeadsService.create` and lets the **tenant's own duplicate
   * rules** decide: that is what "apply duplicate rules, never blind-create" means — a workspace
   * whose rules say `reject` gets a refused row, one whose rules say `attach_to_existing` gets a
   * touchpoint on the lead they already had.
   *
   * `skip_existing` and `update_existing` ask the question themselves first, because they mean
   * something the rules cannot express: "I am re-uploading a list I have imported before." A match
   * under those modes is decided by the same rules and the same matcher, so the three modes never
   * disagree about *what* a duplicate is — only about what to do with one.
   */
  private async applyRow(
    mapped: MappedImportRow,
    mode: string,
    catalogue: ImportCatalogue,
  ): Promise<{ status: RowOutcome; leadId: string | null }> {
    if (mode === 'skip_existing' || mode === 'update_existing') {
      const existing = await this.findExisting(mapped, catalogue);
      if (existing) {
        // The matched lead is recorded either way, including on a skip: "this row is already lead
        // X" is the provenance a person asks for when a re-upload imported nothing.
        if (mode === 'skip_existing') return { status: 'skipped', leadId: existing };
        return {
          status: 'updated',
          leadId: await this.updateExisting(existing, mapped, catalogue),
        };
      }
    }

    const tagIds = await this.resolveTags(mapped, catalogue);
    const parsed = createLeadSchema.safeParse({
      ...mapped.draft,
      ...(Object.keys(mapped.customValues).length > 0 ? { customValues: mapped.customValues } : {}),
      ...(tagIds.length > 0 ? { tagIds } : {}),
      createdVia: 'import',
    });
    if (!parsed.success)
      throw AppError.validation('Some details need correcting', issuesOf(parsed));

    const result = await this.leads.create(parsed.data);
    const attached = 'attachedToExisting' in result && result.attachedToExisting === true;
    if (mapped.capturedAt && !attached) await this.applyCaptureDate(result.id, mapped.capturedAt);
    if (mapped.note) await this.addNote(result.id, mapped.note, mapped.capturedAt);
    return { status: attached ? 'attached' : 'created', leadId: result.id };
  }

  /**
   * The lead this row is about, under the tenant's own matching rules.
   *
   * The phone has to be normalized **here**, before detection. Detection queries the indexed
   * `phone_e164` / `whatsapp_e164` columns with the value it is given — it does not normalize its
   * own subject, because every other caller hands it an already-normalized number. Passing the cell
   * as the file wrote it (`9876543210`) therefore matched nothing, so `skip_existing` and
   * `update_existing` both fell through to creating the lead, and the tenant's duplicate rule then
   * attached it: the right lead, by the wrong route, and the mode the person chose was ignored.
   */
  private async findExisting(
    mapped: MappedImportRow,
    catalogue: ImportCatalogue,
  ): Promise<string | null> {
    const draft = mapped.draft as Record<string, string | undefined>;
    const country = catalogue.defaultPhoneCountry as CountryCode;
    const matches = await this.duplicates.detect({
      phoneE164: toE164(draft['phone'], country),
      whatsappE164: toE164(draft['whatsapp'], country),
      email: draft['email'] ?? null,
      firstName: draft['firstName'] ?? null,
      lastName: draft['lastName'] ?? null,
      company: draft['company'] ?? null,
      city: draft['city'] ?? null,
      postalCode: draft['postalCode'] ?? null,
    });
    return matches[0]?.leadId ?? null;
  }

  private async updateExisting(
    leadId: string,
    mapped: MappedImportRow,
    catalogue: ImportCatalogue,
  ): Promise<string> {
    // Only the fields `updateLeadSchema` accepts: status, stage and assignment are transitions with
    // their own endpoints, their own history and their own permission, and an import is not the
    // place to invent a fourth way of performing them.
    const updatable = pick(mapped.draft, [
      'firstName',
      'lastName',
      'company',
      'jobTitle',
      'phone',
      'whatsapp',
      'email',
      'city',
      'state',
      'country',
      'postalCode',
      'priority',
      'leadSourceId',
      'valueMinor',
      'currency',
      'consent',
    ]);
    if (Object.keys(mapped.customValues).length > 0)
      updatable['customValues'] = mapped.customValues;

    if (Object.keys(updatable).length > 0) {
      const parsed = updateLeadSchema.safeParse(updatable);
      if (!parsed.success)
        throw AppError.validation('Some details need correcting', issuesOf(parsed));
      await this.leads.update(leadId, parsed.data);
    }

    // Tags are added to what the lead already has rather than replacing them: a re-upload that
    // mentions one tag must not strip the five somebody added by hand.
    const tagIds = await this.resolveTags(mapped, catalogue);
    if (tagIds.length > 0) {
      const current = await this.db.client.leadTag.findMany({
        where: { leadId },
        select: { tagId: true },
      });
      const merged = new Set([...current.map((tag) => tag.tagId), ...tagIds]);
      if (merged.size !== current.length) {
        await this.leads.setTags(leadId, { tagIds: [...merged] });
      }
    }

    if (mapped.note) await this.addNote(leadId, mapped.note, mapped.capturedAt);
    return leadId;
  }

  private async resolveTags(
    mapped: MappedImportRow,
    catalogue: ImportCatalogue,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const name of mapped.tagNames.slice(0, 50)) {
      ids.push(await this.catalogues.tagIdFor(catalogue, name));
    }
    return [...new Set(ids)];
  }

  /**
   * The original capture date.
   *
   * Written directly, because `createdAt` is deliberately not settable through the lead API — a
   * caller being able to backdate a lead would make every "new this week" report a guess. An import
   * is the one legitimate exception: a list of last year's enquiries that all arrive dated today
   * makes the first report after a migration useless.
   */
  private async applyCaptureDate(leadId: string, capturedAt: Date): Promise<void> {
    await this.db.client.lead.update({
      where: { id: leadId },
      data: { createdAt: capturedAt, lastActivityAt: capturedAt },
    });
  }

  private async addNote(leadId: string, note: string, occurredAt: Date | null): Promise<void> {
    await this.timeline.record({
      type: ACTIVITY_TYPES.NOTE_ADDED,
      leadId,
      // The note is as old as the capture it came with, so it sits in the right place in the
      // timeline rather than at the top.
      occurredAt: occurredAt ?? new Date(),
      payload: { note, via: 'import' },
    });
  }

  private async recordRow(
    input: { jobId: string; rowNumber: number; record: Record<string, string> },
    status: RowOutcome | 'failed',
    errors: readonly FieldError[],
    leadId: string | null,
  ): Promise<void> {
    const principal = tenantContext.require('imports.recordRow');
    await this.db.client.importRow.upsert({
      // Idempotent on `(organization, job, row number)`: a retry that re-reaches a row it already
      // recorded must not create a second one.
      where: {
        organizationId_jobId_rowNumber: {
          organizationId: principal.organizationId,
          jobId: input.jobId,
          rowNumber: input.rowNumber,
        },
      },
      create: {
        id: newId(),
        organizationId: principal.organizationId,
        jobId: input.jobId,
        rowNumber: input.rowNumber,
        status,
        errors: errors as never,
        raw: input.record as never,
        leadId,
      },
      update: { status, errors: errors as never, leadId },
    });
  }

  private async flush(jobId: string, counters: RunCounters): Promise<void> {
    await this.db.client.importJob.update({
      where: { id: jobId },
      data: {
        processedRows: counters.processed,
        createdCount: counters.created,
        updatedCount: counters.updated,
        attachedCount: counters.attached,
        skippedCount: counters.skipped,
        failedCount: counters.failed,
      },
    });
  }

  private async isCancelled(jobId: string): Promise<boolean> {
    const row = await this.db.client.importJob.findFirst({
      where: { id: jobId },
      select: { status: true },
    });
    return row?.status === 'cancelled';
  }

  /**
   * The failed-rows file (`FR-IO-1`).
   *
   * The original columns, in the original order, plus a `_row` and an `_errors` column — so the
   * person fixes the file they recognise and re-imports it with the mapping they already chose.
   * That is why `csvCell`/`unguardCell` in `@leados/shared` are an exact pair: the formula guard
   * that makes the file safe to open in Excel has to survive a round trip.
   */
  private async writeErrorFile(
    jobId: string,
    header: readonly string[],
    delimiter: string,
  ): Promise<string | null> {
    const failed = await this.db.client.importRow.findMany({
      where: { jobId, status: 'failed' },
      orderBy: { rowNumber: 'asc' },
      take: 10_000,
    });
    if (failed.length === 0) return null;

    const rows = failed.map((row) => {
      const raw = (row.raw ?? {}) as Record<string, string>;
      const errors = (row.errors ?? []) as unknown as FieldError[];
      return [
        String(row.rowNumber),
        errors.map((error) => error.message).join(' '),
        ...header.map((column) => raw[column] ?? ''),
      ];
    });

    const csv = writeCsv(['_row', '_errors', ...header], rows, { delimiter });
    const document = await this.documents.store({
      subject: 'import_errors',
      fileName: `import-${jobId}-errors.csv`,
      mimeType: 'text/csv',
      body: Buffer.from(csv, 'utf8'),
      // A week: long enough to fix a file over a weekend, short enough that failed rows containing
      // personal data do not accumulate forever.
      expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
    });
    return document.id;
  }

  private async failRun(organizationId: string, jobId: string, message: string): Promise<void> {
    await withPlatformScope('imports: fail run', async () => {
      await this.db.client.importJob.update({
        where: { id: jobId },
        data: { status: 'failed', error: message, finishedAt: new Date() },
      });
    });
  }
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) picked[key] = source[key];
  }
  return picked;
}

/** Zod issues → the field-error contract the API already speaks. */
function issuesOf(parsed: {
  error: { issues: readonly { path: readonly PropertyKey[]; message: string; code: string }[] };
}): FieldError[] {
  return parsed.error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || 'row',
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
}

/**
 * Whatever went wrong, as field errors a person can act on.
 *
 * An `AppError` carrying field details already is one; an `AppError` without details (a conflict
 * from a duplicate rule, a plan limit) becomes a single row-level error carrying its message —
 * which is the sentence the API would have shown, so the error file reads the same as the screen.
 */
function fieldErrorsFrom(error: unknown): FieldError[] {
  if (error instanceof AppError) {
    if (Array.isArray(error.details) && error.details.length > 0) {
      return error.details as FieldError[];
    }
    return [{ field: 'row', code: error.code, message: error.message }];
  }
  return [
    {
      field: 'row',
      code: 'UNEXPECTED',
      message: 'This row could not be imported. Please check it and try again.',
    },
  ];
}

/**
 * A cell as E.164, or null when it is not a usable number.
 *
 * Null rather than a thrown error: a row with an unreadable phone is still a row, and whether that
 * is fatal is the lead schema's decision a moment later — not this lookup's.
 */
function toE164(value: string | undefined, country: CountryCode): string | null {
  if (!value) return null;
  try {
    return normalizePhone(value, country).e164;
  } catch {
    return null;
  }
}
