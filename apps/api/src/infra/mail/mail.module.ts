import { Global, Module } from '@nestjs/common';
import { LoggingMailer } from './logging.mailer.js';
import { MAILER } from './mailer.port.js';

@Global()
@Module({
  providers: [{ provide: MAILER, useClass: LoggingMailer }],
  exports: [MAILER],
})
export class MailModule {}
