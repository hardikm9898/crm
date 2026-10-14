import { Global, Module } from '@nestjs/common';
import { LoggingMailer } from './logging.mailer.js';
import { PostmarkMailer } from './postmark.mailer.js';
import { MAILER } from './mailer.port.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { LOGGER } from '../observability/logger.module.js';
import type { Logger } from 'pino';
import { EmailSenderService } from './email-sender.service.js';
import { EmailSuppressionService } from './email-suppression.service.js';

/**
 * Outbound email: the port, its drivers, and the one service every send goes through.
 *
 * `@Global()`, like storage: the four credential processors, the invitation processor and the
 * notification emailer all need it, and the Phase 9 marketing sender will too. A provider's
 * delivery webhook controller lives in `modules/webhooks`, because a public HTTP route is a product
 * surface rather than infrastructure.
 *
 * **The driver is chosen by configuration, not by environment.** `EMAIL_DRIVER=log` refuses to boot
 * in production (in the driver's own constructor), so the two statements — "this deployment sends
 * through Postmark" and "this deployment sends nothing" — are both explicit and neither is implied
 * by `NODE_ENV`.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (config: AppConfig, logger: Logger) =>
        config.EMAIL_DRIVER === 'postmark'
          ? new PostmarkMailer(config, logger)
          : new LoggingMailer(logger, config),
    },
    EmailSenderService,
    EmailSuppressionService,
  ],
  exports: [MAILER, EmailSenderService, EmailSuppressionService],
})
export class MailModule {}
