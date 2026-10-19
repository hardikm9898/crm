import { Controller, Get, Header, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../modules/auth/guards/public.decorator.js';
import { raw } from '../http/envelope.interceptor.js';
import { OpenApiService } from './openapi.service.js';

/**
 * The developer-facing surface: the document, and the pages a person reads (`FR-API-3`).
 *
 * All three are `@Public()`, which is the decision here. A spec behind a credential is a spec
 * nobody evaluating the product can read, and it describes nothing a caller could not learn by
 * trying every path: the paths, the permission each needs and the shape of the bodies. What it
 * deliberately does **not** contain is any workspace's data, any key, or the platform admin
 * surface — those controllers are not in this application's routing table.
 *
 * They answer **raw**: a document wrapped in this product's own envelope would not be an OpenAPI
 * document, and an HTML page wrapped in JSON is not a page.
 */
@Controller()
export class OpenApiController {
  constructor(private readonly openapi: OpenApiService) {}

  @Public()
  @Get('openapi.json')
  @Header('cache-control', 'public, max-age=60')
  document() {
    return raw(this.openapi.document());
  }

  @Public()
  @Get('docs')
  async docs(@Res() reply: FastifyReply) {
    await reply.type('text/html; charset=utf-8').send(this.openapi.docsPage());
  }

  @Public()
  @Get('docs/errors')
  async errors(@Res() reply: FastifyReply) {
    await reply.type('text/html; charset=utf-8').send(this.openapi.errorsPage());
  }
}
