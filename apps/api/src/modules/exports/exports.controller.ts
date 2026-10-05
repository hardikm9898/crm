import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { ExportsService } from './exports.service.js';
import {
  createExportSchema,
  listExportsSchema,
  type CreateExportInput,
  type ListExportsQuery,
} from './exports.dto.js';

/**
 * Exports.
 *
 * The route declares `export:data`; `export:pii` is checked in the service, because whether an
 * export contains personal data depends on the columns in the request. A decorator cannot know
 * that, and declaring the stricter permission on the route would stop a sales manager exporting a
 * pipeline summary with no personal data in it at all.
 */
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  /** The columns a person may pick, each flagged for personal data. */
  @Get('catalogue')
  @RequirePermission(PERMISSIONS.EXPORT_DATA)
  async catalogue() {
    return this.exports.catalogue();
  }

  @Get()
  @RequirePermission(PERMISSIONS.EXPORT_DATA)
  async list(@Query(new ZodBody(listExportsSchema)) query: ListExportsQuery) {
    return this.exports.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.EXPORT_DATA)
  async create(@Body(zodBody(createExportSchema)) body: unknown) {
    return withMessage(
      await this.exports.create(body as CreateExportInput),
      'Preparing your export. It will be ready to download in a moment',
    );
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.EXPORT_DATA)
  async get(@Param('id') id: string) {
    return this.exports.get(id);
  }

  /**
   * The file itself.
   *
   * Straight through the reply, like the import error file: a download is not an envelope. The
   * headers matter — `attachment` so a browser saves it, `nosniff` so a CSV cannot be interpreted
   * as HTML, and `no-store` because a shared machine's cache is not a place for a tenant's leads.
   */
  @Get(':id/download')
  @RequirePermission(PERMISSIONS.EXPORT_DATA)
  async download(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.exports.download(id);
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(file.body);
  }
}
