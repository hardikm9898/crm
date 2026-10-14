import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@leados/shared';
import { RequirePermission } from '../../infra/authz/permission.decorator.js';
import { withMessage } from '../../infra/http/envelope.interceptor.js';
import { zodBody, ZodBody } from '../../infra/http/zod-validation.pipe.js';
import { IngestionService } from './ingestion.service.js';
import {
  listIngestionErrorsSchema,
  listPayloadsSchema,
  testIngestSchema,
  type ListIngestionErrorsQuery,
  type ListPayloadsQuery,
  type TestIngestInput,
} from './ingestion.dto.js';

/**
 * What the workspace can see of its own ingestion (`FR-CAP-6`).
 *
 * All of it behind `api_key:manage`, the permission that already gates the credentials: the
 * payloads are request bodies from the workspace's own integrations, which is developer-facing
 * material rather than lead data, and somebody who can read them can read every lead those
 * payloads became anyway.
 *
 * `POST /ingestion/test` is the self-serve test tool. It is a **POST that persists nothing** —
 * unusual, and deliberate: it carries a payload too large for a query string, and a GET with a
 * body is not a thing. The import wizard's lesson (rendering must not mutate) is respected the
 * other way round: nothing renders this, a person presses it.
 */
@Controller('ingestion')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Get('payloads')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async payloads(@Query(new ZodBody(listPayloadsSchema)) query: ListPayloadsQuery) {
    return this.ingestion.payloads(query);
  }

  @Get('errors')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async errors(@Query(new ZodBody(listIngestionErrorsSchema)) query: ListIngestionErrorsQuery) {
    return this.ingestion.errors(query);
  }

  /** The fields integrations have sent that this workspace has no home for (`FR-CAP-5`). */
  @Get('unmapped')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async unmapped() {
    return this.ingestion.unmapped();
  }

  @Post('test')
  // 200, not 201: a dry run creates nothing, and a 201 would tell every client it did.
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async test(@Body(zodBody(testIngestSchema)) body: unknown) {
    const result = await this.ingestion.dryRun((body as TestIngestInput).payload);
    return withMessage(result, 'Nothing was saved — this is what would have happened');
  }

  @Post('payloads/:id/replay')
  @RequirePermission(PERMISSIONS.API_KEY_MANAGE)
  async replay(@Param('id') id: string) {
    return withMessage(await this.ingestion.replay(id), 'Replayed');
  }
}
