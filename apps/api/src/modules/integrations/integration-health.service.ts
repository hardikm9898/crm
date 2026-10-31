import { Inject, Injectable } from '@nestjs/common';
import {
  findProvider,
  needsReconnect,
  newId,
  nextStatus,
  systemPrincipal,
  tenantContext,
  withPlatformScope,
  type IntegrationStatus,
  type ProbeOutcome,
} from '@leados/shared';
import type { Logger } from 'pino';
import { DbService } from '../../infra/db/db.service.js';
import { LOGGER } from '../../infra/observability/logger.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { IntegrationRegistryService } from './integration-registry.service.js';
import { IntegrationVaultService } from './integration-vault.service.js';
import { sharedSecretField } from './adapters/secret-names.js';
import type { ProbeResult } from './integration.port.js';

/** The row a probe needs, and nothing else. */
interface ProbeSubject {
  readonly id: string;
  readonly organizationId: string;
  readonly provider: string;
  readonly name: string;
  readonly status: IntegrationStatus;
  readonly credentialsEncrypted: string;
  readonly settings: unknown;
  readonly externalAccountId: string | null;
}

/** What one probe did, for a caller and for the log. */
export interface HealthCheckOutcome {
  readonly connectionId: string;
  readonly outcome: ProbeOutcome;
  readonly latencyMs: number | null;
  readonly statusBefore: IntegrationStatus;
  readonly statusAfter: IntegrationStatus;
  readonly detail: Record<string, unknown>;
}

/**
 * Per-connection health checks (Phase 4's "health checks").
 *
 * One service for both callers — the scheduled sweep and the button somebody presses — because a
 * manual check that decided a connection's standing differently from the scheduled one would make
 * the screen disagree with itself. `nextStatus` in `@leados/shared` is the single transition table;
 * this is the single thing that applies it, writes the history row, and tells somebody when a
 * credential has been refused.
 *
 * The sweep's shape is the one the quotation-expiry sweep paid for: read **across** tenants under
 * `withPlatformScope`, then do each tenant's work inside `tenantContext.run(systemPrincipal(...))`.
 * `withPlatformScope` leaves `organizationId()` unset, and everything this writes — the health
 * check row, the connection's status, the notification — takes the workspace from the context.
 */
@Injectable()
export class IntegrationHealthService {
  constructor(
    private readonly db: DbService,
    private readonly registry: IntegrationRegistryService,
    private readonly vault: IntegrationVaultService,
    private readonly notifications: NotificationsService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Probes every connection whose provider asks to be probed on a schedule.
   *
   * Due-ness is computed from the provider's own `probeEveryMinutes` against the connection's last
   * check, rather than from a column: the cadence is catalogue vocabulary, and a stored
   * `next_probe_at` would be a second copy of it that is wrong the day somebody changes the
   * registry. Disconnected connections are excluded by the query, not filtered afterwards — the
   * partial index exists for exactly that predicate.
   */
  async sweep(now = new Date()): Promise<{ probed: number; revoked: number }> {
    const probeable = this.registry
      .providers()
      .filter(
        (provider) => provider.probeEveryMinutes !== null && this.registry.canProbe(provider.key),
      )
      .map((provider) => provider.key);
    if (probeable.length === 0) return { probed: 0, revoked: 0 };

    const subjects = await withPlatformScope(
      'integrations: find the connections whose health check is due',
      async () =>
        this.db.client.integrationConnection.findMany({
          where: { provider: { in: probeable }, disconnectedAt: null },
          select: {
            id: true,
            organizationId: true,
            provider: true,
            name: true,
            status: true,
            credentialsEncrypted: true,
            settings: true,
            externalAccountId: true,
            healthChecks: { orderBy: { checkedAt: 'desc' }, take: 1, select: { checkedAt: true } },
          },
          // A bound, so one workspace with a thousand connections cannot make the tick unbounded.
          // Oldest-checked first, so the bound does not starve anybody: the ones left out this
          // minute are the ones checked most recently.
          orderBy: { updatedAt: 'asc' },
          take: 200,
        }),
    );

    let probed = 0;
    let revoked = 0;
    for (const subject of subjects) {
      const every = findProvider(subject.provider)?.probeEveryMinutes;
      if (every === null || every === undefined) continue;
      const last = subject.healthChecks[0]?.checkedAt ?? null;
      if (last !== null && now.getTime() - last.getTime() < every * 60_000) continue;

      try {
        const result = await this.check(subject);
        probed += 1;
        if (result.statusAfter !== result.statusBefore && needsReconnect(result.statusAfter)) {
          revoked += 1;
        }
      } catch (error) {
        // One workspace's broken connection must not end the sweep for every other workspace —
        // the lesson every platform-scoped sweep in this product has learnt the same way.
        this.logger.error(
          { err: error, connectionId: subject.id, organizationId: subject.organizationId },
          'an integration health check failed outright',
        );
      }
    }
    return { probed, revoked };
  }

  /**
   * One connection, probed, recorded and acted on.
   *
   * Enters the connection's own tenant context, so it is callable from the platform-scoped sweep
   * and from a request that is already inside one (`tenantContext.run` nests harmlessly).
   */
  async check(subject: ProbeSubject): Promise<HealthCheckOutcome> {
    const { adapter } = this.registry.require(subject.provider);
    if (adapter.probe === undefined) {
      // Not an error the caller can fix, and not a status change either: the controller refuses
      // this before it gets here, and the sweep never selects such a provider.
      throw new Error(`${subject.provider} cannot be probed`);
    }

    const secrets = this.vault.open(
      subject.id,
      subject.credentialsEncrypted,
      sharedSecretField(subject.provider),
    );
    const result: ProbeResult = await adapter.probe({
      connectionId: subject.id,
      organizationId: subject.organizationId,
      secrets,
      settings: (subject.settings ?? {}) as Record<string, unknown>,
      externalAccountId: subject.externalAccountId,
    });

    const statusAfter = nextStatus(subject.status, result.outcome);
    await tenantContext.run(systemPrincipal(subject.organizationId, newId()), async () => {
      await this.record(subject, result, statusAfter);
    });

    if (statusAfter !== subject.status && needsReconnect(statusAfter)) {
      await this.announce(subject);
    }
    this.logger.debug(
      {
        connectionId: subject.id,
        provider: subject.provider,
        outcome: result.outcome,
        statusAfter,
      },
      'integration health check',
    );

    return {
      connectionId: subject.id,
      outcome: result.outcome,
      latencyMs: result.latencyMs,
      statusBefore: subject.status,
      statusAfter,
      detail: result.detail,
    };
  }

  private async record(
    subject: ProbeSubject,
    result: ProbeResult,
    statusAfter: IntegrationStatus,
  ): Promise<void> {
    const checkedAt = new Date();
    await this.db.client.$transaction(async (tx) => {
      await tx.integrationHealthCheck.create({
        data: {
          id: newId(),
          organizationId: subject.organizationId,
          connectionId: subject.id,
          outcome: result.outcome,
          latencyMs: result.latencyMs,
          detail: result.detail as never,
          checkedAt,
        },
      });
      await tx.integrationConnection.update({
        where: { id: subject.id },
        data: {
          status: statusAfter,
          // The status and the timestamps are written together, in one statement, because they
          // are one fact: a connection reading `error` whose `last_error_at` belongs to last week
          // is a screen that cannot say when it broke. `last_error` is cleared on a good probe
          // rather than left behind — a working connection carrying yesterday's error message is
          // the half-truth that makes somebody stop believing the rest of the row.
          ...(result.outcome === 'ok'
            ? { lastSuccessAt: checkedAt, lastError: null, lastErrorAt: null }
            : {
                lastErrorAt: checkedAt,
                lastError: describeDetail(result.detail).slice(0, 500),
              }),
        },
      });
    });
  }

  /**
   * Tells the people who could fix it.
   *
   * Only on the **transition** into `revoked`, not on every probe that finds it there: a credential
   * somebody deleted would otherwise produce one notification every ten minutes, which is the
   * shape of alert people mute and then stop reading. `dedupeKey` carries the day as a second
   * guard, for the case where a reconnect-then-revoke happens twice in one afternoon.
   */
  private async announce(subject: ProbeSubject): Promise<void> {
    const label = findProvider(subject.provider)?.label ?? subject.provider;
    const recipients = await this.notifications.recipientsWithPermission(
      subject.organizationId,
      'integration:manage',
    );
    for (const userId of recipients) {
      await this.notifications.create({
        organizationId: subject.organizationId,
        userId,
        type: 'integration.revoked',
        title: `${label} refused our credential`,
        body: `“${subject.name}” has stopped working because the credential was refused. Reconnect it to start it again.`,
        link: '/settings/integrations',
        data: { connectionId: subject.id, provider: subject.provider },
        dedupeKey: `integration-revoked:${subject.id}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }
}

/** The provider's own words, for the connection's `last_error`. Never a credential. */
function describeDetail(detail: Record<string, unknown>): string {
  const message = detail['message'] ?? detail['error'];
  if (typeof message === 'string' && message.trim() !== '') {
    const status = detail['status'];
    return typeof status === 'number' ? `${status}: ${message}` : message;
  }
  const status = detail['status'];
  return typeof status === 'number'
    ? `The provider answered ${status}.`
    : 'The provider could not be reached.';
}
