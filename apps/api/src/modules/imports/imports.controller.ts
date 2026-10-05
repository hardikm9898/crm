import { Body, Controller, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { ImportsService } from './imports.service.js';
import {
  listImportRowsSchema,
  listImportsSchema,
  previewImportSchema,
  setImportMappingSchema,
  uploadImportSchema,
  type ListImportRowsQuery,
  type ListImportsQuery,
  type PreviewImportQuery,
  type SetImportMappingInput,
  type UploadImportInput,
} from './imports.dto.js';

/**
 * The import wizard.
 *
 * Every route is `lead:import`, including the reads: an import job's rows are the contents of
 * somebody's spreadsheet, which is more personal data in one place than any lead screen shows, and
 * the ability to look at them is the ability to read the whole file. `lead:create` is deliberately
 * not enough — importing twelve thousand leads is a different act from creating one.
 */
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** The fields and modes the wizard offers, so the client has no hardcoded list. */
  @Get('catalogue')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async catalogue() {
    return this.imports.catalogue();
  }

  @Get()
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async list(@Query(new ZodBody(listImportsSchema)) query: ListImportsQuery) {
    return this.imports.list(query);
  }

  /**
   * The upload. The body **is** the file (`content-type: text/csv`); the query carries its name.
   *
   * See `infra/http/csv-body.ts` for why this is a raw body rather than multipart, and why only
   * these routes may exceed the global body limit.
   */
  @Post()
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async upload(
    @Query(new ZodBody(uploadImportSchema)) query: UploadImportInput,
    @Body() body: unknown,
  ) {
    const content = typeof body === 'string' ? body : '';
    return withMessage(
      await this.imports.upload(query, content),
      'File read. Check the column mapping before importing',
    );
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async get(@Param('id') id: string) {
    return this.imports.get(id);
  }

  @Get(':id/preview')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async preview(
    @Param('id') id: string,
    @Query(new ZodBody(previewImportSchema)) query: PreviewImportQuery,
  ) {
    return this.imports.preview(id, query);
  }

  @Put(':id/mapping')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async setMapping(@Param('id') id: string, @Body(zodBody(setImportMappingSchema)) body: unknown) {
    return withMessage(
      await this.imports.setMapping(id, body as SetImportMappingInput),
      'Mapping saved',
    );
  }

  /** The dry run, read-only — safe for a page to render (see `ImportsService.check`). */
  @Get(':id/check')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async check(@Param('id') id: string) {
    return this.imports.check(id);
  }

  @Post(':id/validate')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async validate(@Param('id') id: string) {
    return this.imports.validate(id);
  }

  @Post(':id/start')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async start(@Param('id') id: string) {
    return withMessage(
      await this.imports.start(id),
      'Import started. You can leave this page — it keeps running',
    );
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async cancel(@Param('id') id: string) {
    return withMessage(
      await this.imports.cancel(id),
      'Import stopped. The leads already imported are kept',
    );
  }

  @Get(':id/rows')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async rows(
    @Param('id') id: string,
    @Query(new ZodBody(listImportRowsSchema)) query: ListImportRowsQuery,
  ) {
    return this.imports.rows(id, query);
  }

  /**
   * The failed rows, as a file.
   *
   * Sent through the reply directly rather than through the response envelope: this is a download,
   * and a CSV wrapped in `{ success, data }` is not one. `Content-Disposition` names the file so
   * the browser saves rather than renders it — and `nosniff` so a browser cannot decide a CSV
   * containing `<script>` is HTML.
   */
  @Get(':id/errors.csv')
  @RequirePermission(PERMISSIONS.LEAD_IMPORT)
  async errors(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.imports.errorFile(id);
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(file.body);
  }
}
