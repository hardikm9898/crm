import { Inject, Injectable } from '@nestjs/common';
import { newId, systemPrincipal, tenantContext, withPlatformScope } from '@leados/shared';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { JOBS, QUEUES } from '../../infra/queue/queue.constants.js';
import type { JobProcessor } from '../../infra/queue/job-processor.js';
import { ConversationOwnershipService } from './conversation-ownership.service.js';

/**
 * Clears lapsed locks and wakes snoozed conversations (`FR-WA-7`).
 *
 * **Why a sweep at all, when the read already treats an expired lock as absent.** Because the
 * column would otherwise be a lie: a row saying "Nikhil holds this" three days after Nikhil went
 * on holiday is something a person will read and believe, and a lock nothing clears means every
 * screen and every query has to remember to compare it to the clock. One of them eventually will
 * not.
 *
 * **And a snooze has to be delivered, not merely to expire.** `snoozed_until <= now()` as a list
 * predicate would make a conversation visible before anything had told the person who asked to
 * come back to it — the same decision the notification release sweep made, for the same reason,
 * and the reason both run every minute rather than every five.
 *
 * Cross-tenant: the read is platform-scoped and each write enters the row's own workspace, because
 * `withPlatformScope` leaves `tenantContext.organizationId()` unset and both the notification and
 * the audit row take the organization from the context.
 */
@Injectable()
export class ConversationSweepProcessor implements JobProcessor {
  readonly queue = QUEUES.MAINTENANCE;
  readonly jobName = JOBS.CONVERSATION_SWEEP;

  constructor(
    private readonly ownership: ConversationOwnershipService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async process(): Promise<void> {
    const due = await withPlatformScope(
      'conversations: clear lapsed locks and wake snoozed conversations',
      async () => this.ownership.dueForSweep(200),
    );

    let cleared = 0;
    for (const row of due.staleLocks) {
      const did = await tenantContext.run(
        systemPrincipal(row.organizationId, newId()),
        async () => this.ownership.clearLock(row.id),
      );
      if (did) cleared += 1;
    }

    let woken = 0;
    for (const row of due.waking) {
      const did = await tenantContext.run(systemPrincipal(row.organizationId, newId()), async () =>
        this.ownership.wake(row),
      );
      if (did) woken += 1;
    }

    if (cleared > 0 || woken > 0) {
      this.logger.info({ cleared, woken }, 'conversation sweep complete');
    }
  }
}
