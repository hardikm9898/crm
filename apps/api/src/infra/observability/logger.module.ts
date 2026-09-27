import { Global, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { createRootLogger } from './logger.js';

export const LOGGER = Symbol('LOGGER');

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Logger => createRootLogger(config.LOG_LEVEL, false),
    },
  ],
  exports: [LOGGER],
})
export class LoggerModule {}
