import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../../infra/config/config.module.js';
import type { AppConfig } from '../../infra/config/config.schema.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import type { JobPayload } from '../../infra/queue/queue.service.js';

interface SiteRevalidatePayload extends JobPayload {
  readonly aggregateId?: string;
  readonly payload?: { readonly subdomain?: string };
}

/**
 * Drops the web app's cache tag for a site whose published snapshot has changed (`FR-WEB-5`).
 *
 * The renderer serves a published site statically with `revalidate: false` and one tag, so this
 * call is the **only** thing that can change what a visitor sees. A publish that did not reach here
 * would leave the previous version live indefinitely, which is the worst failure this feature has:
 * a business presses Publish, the screen agrees, and their customers keep reading last week's
 * prices.
 *
 * It is a job rather than a call inside `publish()` because of rule 5 — a handler never calls an
 * external API, and events leave through the outbox inside the transaction that wrote the row.
 * That also buys the retry, and a web app mid-deploy is the ordinary reason this call fails: a
 * publish must not fail because the thing it notifies was restarting.
 *
 * **Idempotent by nature.** Dropping a cache tag twice is dropping a cache tag, so an at-least-once
 * delivery needs no guard here — which is worth saying, because most processors in this product do.
 */
@Injectable()
export class SiteRevalidateProcessor implements JobProcessor<SiteRevalidatePayload> {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.SITE_REVALIDATE;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(payload: SiteRevalidatePayload, _job: Job): Promise<void> {
    const subdomain = payload.payload?.subdomain;
    if (typeof subdomain !== 'string' || subdomain.length === 0) {
      // The event carries the subdomain because the cache tag is keyed on it: the site's id is
      // deliberately absent from the public response, so the renderer has no id to be tagged by.
      throw new Error(
        `site revalidation for website ${payload.aggregateId ?? 'unknown'} carried no subdomain, and the cache tag is keyed on it`,
      );
    }

    const secret = this.config.WEB_REVALIDATE_SECRET;
    if (secret === undefined) {
      // Thrown rather than skipped with a warning. A warning leaves a stale site live with nothing
      // but a log line nobody reads; a throw retries, dead-letters, and lands in `job_failures`
      // and `/health/deep`'s dead-letter count — which is where a misconfiguration belongs. The
      // variable is named so the fix is one line.
      throw new Error(
        'WEB_REVALIDATE_SECRET is not set, so a published site cannot be revalidated and visitors will keep seeing the previous version',
      );
    }

    const url = `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/api/revalidate-site`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-revalidate-secret': secret },
      body: JSON.stringify({ subdomain }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`site revalidation failed: ${response.status} ${detail}`);
    }

    this.logger.debug({ subdomain, website: payload.aggregateId }, 'site revalidated');
  }
}
