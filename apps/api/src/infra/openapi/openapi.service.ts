import { Inject, Injectable } from '@nestjs/common';
import { RouteAuditService } from '../authz/route-audit.service.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { buildDocument, type OpenApiOptions } from './openapi.document.js';
import { renderDocsPage, renderErrorsPage } from './docs-page.js';

/**
 * The published contract (`FR-API-3`).
 *
 * The document is built on demand from the routing table rather than generated at build time into
 * a file the server then serves: a file can be stale, and the one thing this document must never
 * be is a description of a previous release. The committed artifact at `docs/openapi.json` is the
 * **diff baseline**, not the source — `openapi.int-spec.ts` fails when the two disagree, which is
 * the check the brief asks for.
 */
export const API_VERSION = '1.0.0';

@Injectable()
export class OpenApiService {
  constructor(
    private readonly routes: RouteAuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  options(): OpenApiOptions {
    return {
      version: API_VERSION,
      // The origin a client calls, from configuration rather than from the request: a document
      // that echoes whatever `Host` header it was asked with is a document that tells an attacker's
      // proxy to be the server.
      serverUrl: this.config.API_PUBLIC_URL,
      prefix: '/api/v1',
    };
  }

  document(): Record<string, unknown> {
    return buildDocument(this.routes.collect(), this.options());
  }

  docsPage(): string {
    return renderDocsPage(this.document(), '/openapi.json');
  }

  errorsPage(): string {
    return renderErrorsPage();
  }
}
