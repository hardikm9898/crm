import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  DEFAULT_EXPORT_COLUMNS,
  PERMISSIONS,
  exportIncludesPii,
  exportableColumns,
  newId,
  tenantContext,
  unknownExportColumns,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { AuditService } from '../../infra/audit/audit.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import { QueueService } from '../../infra/queue/queue.service.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import type { CreateExportInput, ListExportsQuery } from './exports.dto.js';

/**
 * Exports (`FR-IO-3`).
 *
 * Three decisions worth stating:
 *
 *  * **A job, not a response.** A hundred thousand leads cannot be assembled inside an HTTP
 *    request, and a file that exists on the other side is one a person can fetch twice, share a
 *    link to, and come back to after lunch.
 *  * **Personal data is a permission, not a warning.** `export:data` lets somebody export; the
 *    moment a chosen column is personal data, `export:pii` is required as well. A sales executive
 *    can take a pipeline report home; taking ten thousand phone numbers is a different act, and the
 *    audit entry says who did it (`docs/security.md` §7).
 *  * **The link expires.** An export URL is a bearer of the whole list to anyone who has it, so the
 *    document carries an expiry and the hourly sweep drops the bytes. The row stays: who exported
 *    what is history, and deleting the evidence with the file would defeat the audit entry.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly db: DbService,
    private readonly documents: DocumentsService,
    private readonly fields: FieldRegistryService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** The columns a person may choose, with their personal-data flags, so the UI can warn honestly. */
  async catalogue() {
    return {
      columns: await this.columnCatalogue(),
      defaults: DEFAULT_EXPORT_COLUMNS,
      retentionHours: this.config.EXPORT_RETENTION_HOURS,
    };
  }

  async create(input: CreateExportInput) {
    const principal = tenantContext.require('exports.create');
    const catalogue = await this.columnCatalogue();
    const columns = input.columns ?? [...DEFAULT_EXPORT_COLUMNS];

    const unknown = unknownExportColumns(columns, catalogue);
    if (unknown.length > 0) {
      throw AppError.validation('Some of those columns do not exist', [
        {
          field: 'columns',
          code: 'UNKNOWN_COLUMN',
          message: `This workspace has no column called ${unknown.map((name) => `“${name}”`).join(', ')}.`,
        },
      ]);
    }

    const includesPii = exportIncludesPii(columns, catalogue);
    if (includesPii && !principal.permissions.has(PERMISSIONS.EXPORT_PII)) {
      // Not a validation failure: the request is well formed and refused. The message names the
      // columns so the person can export the rest rather than guess which one was the problem.
      const offending = catalogue
        .filter((column) => column.pii && columns.includes(column.key))
        .map((column) => column.label);
      throw new AppError(
        'PERMISSION_DENIED',
        `Exporting ${offending.join(', ')} needs permission to include personal data. ` +
          'Remove those columns, or ask an administrator.',
        403,
        { permission: PERMISSIONS.EXPORT_PII, columns: offending },
      );
    }

    // A saved view is resolved at generation time, not here: the whole point of exporting a view is
    // that it is the view's current definition, and a copy taken now could be stale by the time the
    // job runs.
    if (input.viewId === undefined && input.filter === undefined) {
      throw AppError.validation('Say what to export', [
        {
          field: 'filter',
          code: 'FILTER_REQUIRED',
          message: 'Choose a saved view, or apply a filter — an unfiltered export is rarely meant.',
        },
      ]);
    }

    const id = newId();
    await this.db.client.exportJob.create({
      data: {
        id,
        organizationId: principal.organizationId,
        entityType: input.entityType,
        filters: {
          ...(input.viewId ? { viewId: input.viewId } : {}),
          ...(input.filter ? { filter: input.filter } : {}),
          ...(input.deleted === true ? { deleted: true } : {}),
          ...(input.at ? { at: input.at.toISOString() } : {}),
        } as never,
        columns: columns as never,
        status: 'queued',
        includesPii,
        requestedById: principal.actorId ?? null,
      },
    });

    // Recorded at request time rather than at completion: the act being audited is somebody asking
    // for the data, and a job that fails half way still asked.
    await this.audit.record({
      action: includesPii ? 'export.requested_pii' : 'export.requested',
      resourceType: 'export_job',
      resourceId: id,
      after: { columns, includesPii, viewId: input.viewId ?? null },
    });

    await this.queue.enqueue(
      QUEUES.IMPORTS_EXPORTS,
      JOBS.EXPORT_GENERATE,
      { organizationId: principal.organizationId, exportJobId: id, aggregateId: id },
      { jobId: `export-${id}` },
    );
    this.logger.info({ exportJobId: id, includesPii }, 'export queued');

    return this.get(id);
  }

  async list(query: ListExportsQuery) {
    const rows = await this.db.client.exportJob.findMany({
      where: { ...(query.status ? { status: query.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
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
    const job = await this.db.client.exportJob.findFirst({ where: { id } });
    if (!job) throw AppError.notFound('Export');
    return this.summarize(job);
  }

  /** The file. Authorization is the route's; expiry is the document service's. */
  async download(id: string): Promise<{ fileName: string; body: Buffer }> {
    const job = await this.db.client.exportJob.findFirst({ where: { id } });
    if (!job) throw AppError.notFound('Export');
    if (job.status !== 'completed' || !job.documentId) {
      throw AppError.businessRule(
        job.status === 'failed'
          ? 'That export failed, so there is nothing to download.'
          : 'That export is still being prepared.',
      );
    }

    const principal = tenantContext.require('exports.download');
    if (job.includesPii && !principal.permissions.has(PERMISSIONS.EXPORT_PII)) {
      // Checked again at download, not only at creation: permissions change, and a file containing
      // personal data must stop being reachable by somebody whose access was taken away.
      throw AppError.permissionDenied(PERMISSIONS.EXPORT_PII);
    }

    const { document, body } = await this.documents.read(job.documentId);
    await this.audit.record({
      action: job.includesPii ? 'export.downloaded_pii' : 'export.downloaded',
      resourceType: 'export_job',
      resourceId: id,
      after: { fileName: document.fileName, rowCount: job.rowCount },
    });
    return { fileName: document.fileName, body };
  }

  private async columnCatalogue() {
    const definitions = await this.fields.definitionsFor('lead');
    return exportableColumns(
      definitions.map((definition) => ({
        key: definition.key,
        label: definition.label,
        type: definition.type,
        isPii: definition.isPii,
      })),
    );
  }

  private summarize(job: {
    id: string;
    entityType: string;
    status: string;
    columns: unknown;
    filters: unknown;
    rowCount: number;
    error: string | null;
    documentId: string | null;
    expiresAt: Date | null;
    includesPii: boolean;
    requestedById: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: job.id,
      entityType: job.entityType,
      status: job.status,
      columns: job.columns as string[],
      filters: job.filters as Record<string, unknown>,
      rowCount: job.rowCount,
      error: job.error,
      includesPii: job.includesPii,
      /**
       * A link is only offered while the bytes are still there. Expiry is part of the answer: the
       * row survives the sweep (who exported what is history), so `completed` alone would keep
       * offering a download that 410s.
       */
      downloadable:
        job.status === 'completed' &&
        job.documentId !== null &&
        (job.expiresAt === null || job.expiresAt.getTime() > Date.now()),
      expiresAt: job.expiresAt,
      requestedById: job.requestedById,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      createdAt: job.createdAt,
    };
  }
}
