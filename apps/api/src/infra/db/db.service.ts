import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createDbClient, type DbClient } from '@leados/db';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { LOGGER } from '../observability/logger.module.js';

/**
 * Owns the single tenant-scoped Prisma client for this process.
 *
 * Application code receives `DbClient` — already scoped by the active tenant context.
 * There is no supported way for a module to obtain an unscoped client
 * (docs/security.md §3 layer 2); platform work widens scope explicitly through
 * `withPlatformScope()` instead.
 */
@Injectable()
export class DbService implements OnApplicationShutdown {
  readonly client: DbClient;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.client = createDbClient({
      connectionString: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      log: config.NODE_ENV === 'development',
      onViolation: (violation) => {
        // A cross-tenant attempt is a security event, not a validation error.
        this.logger.error({ violation }, 'CROSS-TENANT ACCESS ATTEMPT BLOCKED');
      },
    });
  }

  async ping(): Promise<number> {
    const startedAt = performance.now();
    await this.client.$queryRaw`SELECT 1`;
    return Math.round(performance.now() - startedAt);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
