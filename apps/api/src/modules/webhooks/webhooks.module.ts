import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { EmailWebhookController } from './email-webhook.controller.js';
import { WebhookDispatchService } from './webhook-dispatch.service.js';
import { WebhookUrlService } from './webhook-url.service.js';
import { WebhooksController } from './webhooks.controller.js';
import {
  WebhookDeliverProcessor,
  WebhookFanoutProcessor,
  WebhookRetrySweepProcessor,
} from './webhooks.processor.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Webhooks, in **both** directions.
 *
 * Inbound (`EmailWebhookController`, Phase 3 step 7, §7 of `api-architecture.md`): somebody else's
 * provider posting to us. Outbound (everything else here, `FR-API-4`, §8): us posting to somebody
 * else's server. They share a module because they share a vocabulary — a signature over a raw body,
 * an idempotency story, a contract with a system we do not control — and because a reader looking
 * for "the webhook code" should find both in one place.
 *
 * They do **not** share a prefix by accident: `POST /webhooks/email` is a literal segment and the
 * outbound routes take a UUID, which the global `UuidParamPipe` keeps unambiguous. A later inbound
 * collector arrives under `/wh/{provider}/{connectionId}` with the integration framework, where
 * connection ids come from.
 *
 * `NotificationsModule` because an endpoint that fails fifteen times in a row is switched off and
 * somebody has to be told — a workspace whose integration has silently stopped receiving everything
 * is the failure this phase exists to prevent on the way in, seen from the way out.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [EmailWebhookController, WebhooksController],
  providers: [
    WebhooksService,
    WebhookDispatchService,
    WebhookUrlService,
    WebhookFanoutProcessor,
    WebhookDeliverProcessor,
    WebhookRetrySweepProcessor,
  ],
  exports: [
    WebhooksService,
    WebhookDispatchService,
    WebhookFanoutProcessor,
    WebhookDeliverProcessor,
    WebhookRetrySweepProcessor,
  ],
})
export class WebhooksModule {}
