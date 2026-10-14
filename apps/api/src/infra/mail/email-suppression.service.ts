import { Injectable } from '@nestjs/common';
import {
  newId,
  normaliseEmailAddress,
  suppressionStops,
  withPlatformScope,
  type SuppressionReason,
} from '@leados/shared';
import { DbService } from '../db/db.service.js';

export interface Suppression {
  readonly id: string;
  readonly identifier: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly createdAt: Date;
}

/**
 * The addresses the platform will not email, and why (`FR-PRV-2`).
 *
 * **Platform-wide and keyed on the address alone.** A hard bounce or a complaint is a fact about a
 * *mailbox*, not about one workspace's relationship with it, and the thing it protects — the
 * sending domain's reputation — is shared by every workspace on the platform. The tenant-scoped
 * `suppressions` table of `docs/database-design.md` §13 is the other half of `FR-PRV-2`, a
 * workspace's own opt-outs per channel, and arrives with marketing in Phase 9 (ADR-0028).
 *
 * Every read and write is under `withPlatformScope`, explicitly: these rows belong to no
 * organization, so the scoping extension has nothing to filter on and the opt-in says why.
 */
@Injectable()
export class EmailSuppressionService {
  constructor(private readonly db: DbService) {}

  /**
   * The suppression that stops this email, or `null`.
   *
   * Takes the **kind**, because how much a suppression stops depends on why it exists: a bounce
   * stops everything (the mailbox is gone), a complaint stops everything except the password reset
   * the person themselves just asked for. `suppressionStops` in `@leados/shared` is the one place
   * that decides, so the sender, the tests and the screens cannot disagree.
   */
  async blocking(address: string, kind: string): Promise<Suppression | null> {
    const row = await this.find(address);
    if (!row) return null;
    return suppressionStops(row.reason, kind) ? row : null;
  }

  async find(address: string): Promise<Suppression | null> {
    const identifier = normaliseEmailAddress(address);
    return withPlatformScope('email: read suppression list', async () =>
      this.db.client.emailSuppression.findUnique({ where: { identifier } }),
    );
  }

  /** The suppressions covering a set of addresses, for a screen that lists people. */
  async forAddresses(addresses: readonly string[]): Promise<Map<string, Suppression>> {
    const identifiers = [...new Set(addresses.map(normaliseEmailAddress))].filter(
      (value) => value !== '',
    );
    if (identifiers.length === 0) return new Map();
    const rows = await withPlatformScope('email: read suppressions for addresses', async () =>
      this.db.client.emailSuppression.findMany({ where: { identifier: { in: identifiers } } }),
    );
    return new Map(rows.map((row) => [row.identifier, row]));
  }

  /**
   * Puts an address on the list, once.
   *
   * **Upsert rather than check-then-insert**, because a provider webhook is at-least-once and two
   * deliveries of the same bounce arrive concurrently: the unique index on `identifier` is the
   * thing that makes this safe, and a read first would let both pass. The first reason wins — an
   * address that hard-bounced and later complained is still, first and most importantly, an address
   * that does not exist.
   */
  async record(input: {
    readonly address: string;
    readonly reason: SuppressionReason;
    readonly detail?: string | null;
    readonly sourceMessageId?: string | null;
  }): Promise<Suppression> {
    const identifier = normaliseEmailAddress(input.address);
    return withPlatformScope('email: record suppression', async () =>
      this.db.client.emailSuppression.upsert({
        where: { identifier },
        create: {
          id: newId(),
          identifier,
          reason: input.reason,
          detail: input.detail ?? null,
          sourceMessageId: input.sourceMessageId ?? null,
        },
        update: {},
      }),
    );
  }

  /**
   * Takes an address off the list.
   *
   * Exists because a suppression is sometimes wrong — a mailbox that was full and is now fixed, a
   * complaint from somebody who has since asked to be put back on. There is no screen for it in
   * this step and no permission that reaches it: it is called by the operator console in Phase 10
   * and is here now because the method a human will need is better written beside the one that
   * creates the row than bolted on later.
   */
  async release(address: string): Promise<boolean> {
    const identifier = normaliseEmailAddress(address);
    const removed = await withPlatformScope('email: release suppression', async () =>
      this.db.client.emailSuppression.deleteMany({ where: { identifier } }),
    );
    return removed.count > 0;
  }
}
