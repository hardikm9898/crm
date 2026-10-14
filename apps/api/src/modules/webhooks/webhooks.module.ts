import { Module } from '@nestjs/common';
import { EmailWebhookController } from './email-webhook.controller.js';

/**
 * Inbound webhooks from providers.
 *
 * A module of its own, and in `modules/` rather than `infra/`, because a public HTTP route is a
 * product surface: it has an authentication story, an idempotency story and a contract with
 * somebody else's system. The adapters it drives live in `infra/`, which is the right way round —
 * the provider's vocabulary is translated at the port, and this controller only authenticates,
 * dispatches and counts.
 *
 * The telephony and WhatsApp webhooks (Phase 4–5) belong here too, for the same reasons.
 */
@Module({
  controllers: [EmailWebhookController],
})
export class WebhooksModule {}
