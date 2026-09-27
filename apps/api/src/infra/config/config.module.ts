import { Global, Module } from '@nestjs/common';
import { loadConfig, type AppConfig } from './config.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Configuration is resolved and validated exactly once, at boot. Nothing reads
 * process.env anywhere else in the codebase.
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
