import { Inject, Injectable } from '@nestjs/common';
import {
  PERMISSIONS,
  exportableColumns,
  csvPrelude,
  csvRow,
  minorUnitExponent,
  zonedParts,
  tenantContext,
  withPlatformScope,
  type ExportableColumn,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { DataScopeService, applyScopeFilter } from '../../infra/authz/data-scope.service.js';
import { PrincipalService } from '../auth/application/principal.service.js';
import { FieldRegistryService } from '../custom-fields/field-registry.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FilterCompilerService } from '../views/filter-compiler.service.js';
import { ViewsService } from '../views/views.service.js';

/**
 * Generating an export file.
 *
 * The thing to get right here is **scope**. An export is the single easiest way to leak a whole
 * workspace, so the file is built as the person who asked for it: their principal, their
 * `lead:read` scope, their saved view. A generator running as a system principal would produce a
 * correct-looking CSV containing every branch's leads, and nobody would notice until it mattered.
 *
 * The second thing is memory. Rows are fetched in pages and appended to the file as text, so a
 * 100 000-lead export costs one page of hydrated rows at a time rather than all of them at once.
 */

/** Rows per page. Large enough to be few round trips, small enough to stay bounded. */
const PAGE_SIZE = 500;

/**
 * A hard ceiling.
 *
 * Not only for the worker's time: the storage port takes a `Buffer`, so the finished file is held
 * in memory before it is written. 100 000 rows of a typical column set is tens of megabytes, which
 * is affordable; a million is not. Streaming an object into storage is a port change that belongs
 * with the S3 driver, and until then this number is the honest limit rather than an optimistic one.
 */
const MAX_EXPORT_ROWS = 100_000;

@Injectable()
export class ExportGeneratorService {
  constructor(
    private readonly db: DbService,
    private readonly documents: DocumentsService,
    private readonly scopes: DataScopeService,
    private readonly filters: FilterCompilerService,
    private readonly views: ViewsService,
    private readonly fields: FieldRegistryService,
    private readonly principals: PrincipalService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async run(organizationId: string, exportJobId: string): Promise<void> {
    const job = await withPlatformScope('exports: load job for run', async () =>
      this.db.client.exportJob.findFirst({ where: { id: exportJobId, organizationId } }),
    );
    if (!job) {
      this.logger.error({ exportJobId, organizationId }, 'export job not found');
      return;
    }
    if (job.status === 'completed') return; // a duplicate delivery of a finished job
    if (!job.requestedById) {
      await this.fail(organizationId, exportJobId, 'This export has no requester.');
      return;
    }

    let principal;
    try {
      principal = await this.principals.build({
        userId: job.requestedById,
        organizationId,
        sessionId: exportJobId,
        requestId: `export-${exportJobId}`,
      });
    } catch {
      await this.fail(
        organizationId,
        exportJobId,
        'The person who asked for this export no longer has access to this workspace.',
      );
      return;
    }

    await tenantContext.run(principal, async () => {
      try {
        await this.generate(exportJobId);
      } catch (error) {
        this.logger.error({ exportJobId, error }, 'export generation failed');
        await this.fail(
          organizationId,
          exportJobId,
          'This export could not be generated. Please try again.',
        );
      }
    });
  }

  private async generate(exportJobId: string): Promise<void> {
    const job = await this.db.client.exportJob.findFirstOrThrow({ where: { id: exportJobId } });
    // Timestamps are rendered in the workspace's own timezone: a file a business opens in Excel
    // should say when something happened *to them*, and an ISO timestamp in UTC reads as a bug to
    // everybody who is not a programmer.
    const organization = await this.db.client.organization.findUniqueOrThrow({
      where: { id: job.organizationId },
      select: { timezone: true },
    });
    await this.db.client.exportJob.update({
      where: { id: exportJobId },
      data: { status: 'running', startedAt: new Date(), error: null },
    });

    const request = (job.filters ?? {}) as {
      viewId?: string;
      filter?: unknown;
      deleted?: boolean;
      at?: string;
    };
    const chosen = (job.columns ?? []) as string[];
    const catalogue = await this.catalogue();
    const columns = chosen
      .map((key) => catalogue.find((column) => column.key === key))
      .filter((column): column is ExportableColumn => column !== undefined);

    // Scope first: if this person may see nothing, the file is a header and no rows — which is the
    // honest answer, and very different from an unscoped query returning everything.
    const scopeFilter = this.scopes.filterFor(PERMISSIONS.LEAD_READ, {
      userColumn: 'assignedUserId',
      teamColumn: 'teamId',
      branchColumn: 'branchId',
    });

    let filter: unknown = request.filter;
    if (request.viewId) {
      const view = await this.views.forSearch(request.viewId);
      filter = view.filters;
    }
    const compiled = await this.filters.compile({
      filter,
      ...(request.at ? { at: new Date(request.at) } : {}),
    });

    const baseWhere: Record<string, unknown> = {
      deletedAt: request.deleted === true ? { not: null } : null,
      ...(Object.keys(compiled.where).length > 0 ? { AND: [compiled.where] } : {}),
    };
    const where = applyScopeFilter(baseWhere, scopeFilter);

    // The file is built a page at a time, through the shared writer's own row function: it owns the
    // quoting, the formula guard and the BOM/CRLF that make the file open correctly in Excel, and an
    // export that wrote its own CSV would be the second implementation of all three. Appending each
    // page's text and letting its cell arrays go is what keeps a 100 000-row export's memory to one
    // page of rows plus the finished text, rather than every cell of every row at once.
    let text = csvPrelude() + csvRow(columns.map((column) => column.label));
    let rowCount = 0;

    if (where !== null) {
      let cursor: string | undefined;
      for (;;) {
        const page = await this.db.client.lead.findMany({
          where,
          // Ordered by id, not by a business column: a cursor over a mutable sort key can skip or
          // repeat rows while the export runs, and an export that quietly omits leads is worse than
          // a slow one.
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          include: {
            status: { select: { name: true } },
            stage: { select: { name: true } },
            pipeline: { select: { name: true } },
            source: { select: { name: true } },
            tags: { include: { tag: { select: { name: true } } } },
          },
        });
        if (page.length === 0) break;

        const ownerNames = await this.ownerNames(page.map((lead) => lead.assignedUserId));
        for (const lead of page) {
          text += csvRow(
            columns.map((column) => this.valueFor(column, lead, ownerNames, organization.timezone)),
          );
          rowCount += 1;
        }
        cursor = page.at(-1)?.id;
        if (page.length < PAGE_SIZE || rowCount >= MAX_EXPORT_ROWS) break;
      }
    }

    const expiresAt = new Date(Date.now() + this.config.EXPORT_RETENTION_HOURS * 3_600_000);
    const document = await this.documents.store({
      subject: 'export',
      fileName: `leads-${new Date().toISOString().slice(0, 10)}.csv`,
      mimeType: 'text/csv',
      body: Buffer.from(text, 'utf8'),
      expiresAt,
    });

    await this.db.client.exportJob.update({
      where: { id: exportJobId },
      data: {
        status: 'completed',
        rowCount,
        documentId: document.id,
        expiresAt,
        finishedAt: new Date(),
      },
    });
    this.logger.info({ exportJobId, rowCount }, 'export generated');
  }

  /**
   * Owner names for a page of leads.
   *
   * Through `Membership`, not `User`: a name is only ours to show because the person is a member of
   * this workspace, and reading `users` directly would be the one place an export could reach
   * outside the tenant.
   */
  private async ownerNames(
    userIds: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const memberships = await this.db.client.membership.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, user: { select: { name: true, email: true } } },
    });
    return new Map(
      memberships.map((membership) => [
        membership.userId,
        membership.user.name || membership.user.email,
      ]),
    );
  }

  /** One cell. Everything is rendered as text here; `csvCell` does the quoting and the guard. */
  private valueFor(
    column: ExportableColumn,
    lead: Record<string, unknown> & {
      status?: { name: string } | null;
      stage?: { name: string } | null;
      pipeline?: { name: string } | null;
      source?: { name: string } | null;
      tags?: readonly { tag: { name: string } }[];
    },
    ownerNames: ReadonlyMap<string, string>,
    timeZone: string,
  ): string {
    switch (column.key) {
      case 'status':
        return lead.status?.name ?? '';
      case 'stage':
        return lead.stage?.name ?? '';
      case 'pipeline':
        return lead.pipeline?.name ?? '';
      case 'source':
        return lead.source?.name ?? '';
      case 'owner': {
        const id = lead['assignedUserId'];
        return typeof id === 'string' ? (ownerNames.get(id) ?? '') : '';
      }
      case 'tags':
        return (lead.tags ?? []).map((link) => link.tag.name).join(', ');
      case 'phone':
        return asText(lead['phoneE164']);
      case 'whatsapp':
        return asText(lead['whatsappE164']);
      case 'value': {
        const minor = lead['valueMinor'];
        if (minor === null || minor === undefined) return '';
        // A whole amount, matching what the import's `value` column accepts — so a round trip
        // through export, edit, re-import does not divide or multiply anybody's pipeline by 100.
        // Unformatted on purpose: grouping separators are what a spreadsheet does, not what a data
        // file should carry.
        return wholeAmount(Number(minor), asText(lead['currency']));
      }
      case 'utmSource':
        return asText(utm(lead)['source']);
      case 'utmMedium':
        return asText(utm(lead)['medium']);
      case 'utmCampaign':
        return asText(utm(lead)['campaign']);
      default:
        break;
    }

    if (column.key.startsWith('custom.')) {
      const values = (lead['customValues'] ?? {}) as Record<string, unknown>;
      return renderCustom(values[column.key.slice('custom.'.length)]);
    }
    const value = lead[column.key];
    return value instanceof Date ? localTimestamp(value, timeZone) : asText(value);
  }

  private async catalogue(): Promise<readonly ExportableColumn[]> {
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

  private async fail(organizationId: string, exportJobId: string, message: string): Promise<void> {
    await withPlatformScope('exports: fail run', async () => {
      await this.db.client.exportJob.update({
        where: { id: exportJobId },
        data: { status: 'failed', error: message, finishedAt: new Date() },
      });
    });
  }
}

function utm(lead: Record<string, unknown>): Record<string, unknown> {
  return (lead['utm'] ?? {}) as Record<string, unknown>;
}

/**
 * A timestamp a person can read, in the workspace's timezone.
 *
 * `YYYY-MM-DD HH:mm` rather than a locale format: it sorts correctly as text in every spreadsheet,
 * it is unambiguous (unlike anything with a slash in it), and it is what `parseSpreadsheetDate`
 * accepts on the way back in — so export, edit, re-import does not move every date by a day.
 */
function localTimestamp(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${two(parts.month)}-${two(parts.day)} ${two(parts.hour)}:${two(parts.minute)}`;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/**
 * A custom value as text.
 *
 * A `currency` field is stored as `{ currency, amountMinor }` and a multi-value field as an array —
 * both of which `String()` would render as `[object Object]` and `a,b` respectively, the second of
 * those being indistinguishable from two columns once it is in a CSV.
 */
function renderCustom(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => asText(item)).join('; ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('amountMinor' in record) {
      const currency = asText(record['currency']);
      const amount = wholeAmount(Number(record['amountMinor'] ?? 0), currency);
      return currency ? `${currency} ${amount}` : amount;
    }
    return JSON.stringify(value);
  }
  return asText(value);
}

/**
 * Minor units → the whole amount, with the number of decimals the currency actually has.
 *
 * Hardcoding two would print ¥1 000 as 10.00; `minorUnitExponent` is the same function the money
 * helpers use, so an export and a lead screen never disagree about where the point goes.
 */
function wholeAmount(minor: number, currency: string): string {
  const exponent = minorUnitExponent(currency || 'INR');
  return (minor / 10 ** exponent).toFixed(exponent);
}
