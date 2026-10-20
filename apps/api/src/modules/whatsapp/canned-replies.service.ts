import { Injectable } from '@nestjs/common';
import {
  AppError,
  CANNED_REPLY_VISIBILITIES,
  cannedReplyProblem,
  newId,
  normaliseShortcut,
  tenantContext,
  type CannedReplyVisibility,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';

/**
 * Canned replies: a shortcut an agent types and the wording it stands for (`FR-WA-7`).
 *
 * Four decisions:
 *
 *  * **`usage_count` counts sends, not clicks.** The picker is ordered by it, and a count of
 *    clicks would promote whatever is easiest to misclick. The send carries the id it used, which
 *    is also what makes "which wording actually works" answerable later.
 *  * **A private reply is unique per person, a shared one per workspace.** Two agents may each
 *    keep their own `/thanks`; one shared `/price-list` is the point of sharing. That is one
 *    partial unique on `(organization, owner, shortcut) WHERE deleted_at IS NULL`, and the
 *    `WHERE` is what lets a workspace reuse a shortcut it retired.
 *  * **An archived reply is not offered and not deleted.** `messages.canned_reply_id` is
 *    `Restrict`, so a reply that has been sent has history pointing at it; deleting it would
 *    either fail or take the history.
 *  * **The shortcut is cleaned, not demanded.** `normaliseShortcut` adds the slash and hyphenates
 *    what somebody typed — making a person type punctuation exactly is how a feature goes unused,
 *    and a shortcut with a capital in it is one the composer would never match.
 */
@Injectable()
export class CannedRepliesService {
  constructor(private readonly db: DbService) {}

  /** What this person may use: the workspace's shared replies and their own private ones. */
  async list() {
    const principal = tenantContext.require('cannedReplies.list');
    const rows = await this.db.client.cannedReply.findMany({
      where: {
        deletedAt: null,
        // Not `OR` with a bare key: this is the only predicate here, but written the same way as
        // everywhere else so a second one cannot silently replace it.
        AND: [
          {
            OR: [{ visibility: 'shared' }, { visibility: 'private', ownerUserId: principal.actorId }],
          },
        ],
      },
      orderBy: [{ usageCount: 'desc' }, { shortcut: 'asc' }],
      take: 200,
      include: { owner: { select: { userId: true, user: { select: { name: true } } } } },
    });
    return {
      items: rows.map((row) => this.present(row)),
      pagination: { limit: 200, nextCursor: null, hasMore: false, total: rows.length },
    };
  }

  async create(input: { shortcut: string; body: string; visibility: CannedReplyVisibility }) {
    const principal = tenantContext.require('cannedReplies.create');
    const ownerUserId = principal.actorId;
    if (ownerUserId === undefined) {
      throw AppError.businessRule('A canned reply has to be written by a person.');
    }
    const problem = cannedReplyProblem(input);
    if (problem !== null) {
      throw AppError.validation('That canned reply cannot be saved', [
        { field: problem.field, code: 'CANNED_REPLY_INVALID', message: problem.message },
      ]);
    }
    const shortcut = normaliseShortcut(input.shortcut);
    await this.requireFreeShortcut(shortcut, ownerUserId, input.visibility, null);

    const id = newId();
    await this.db.client.cannedReply.create({
      data: {
        id,
        organizationId: principal.organizationId,
        shortcut,
        body: input.body.trim(),
        visibility: input.visibility,
        ownerUserId,
      },
    });
    return this.list();
  }

  async update(
    id: string,
    input: { shortcut?: string; body?: string; visibility?: CannedReplyVisibility },
  ) {
    const principal = tenantContext.require('cannedReplies.update');
    const existing = await this.row(id);
    // A private reply is its owner's; a shared one belongs to the workspace, and anybody who may
    // reply may fix the wording everybody sends. Refusing that would make a typo in a shared reply
    // something only one person could correct.
    if (existing.visibility === 'private' && existing.ownerUserId !== principal.actorId) {
      throw AppError.notFound('Canned reply');
    }

    const shortcut =
      input.shortcut === undefined ? existing.shortcut : normaliseShortcut(input.shortcut);
    const body = input.body === undefined ? existing.body : input.body.trim();
    const visibility = input.visibility ?? (existing.visibility as CannedReplyVisibility);
    const problem = cannedReplyProblem({ shortcut, body });
    if (problem !== null) {
      throw AppError.validation('That canned reply cannot be saved', [
        { field: problem.field, code: 'CANNED_REPLY_INVALID', message: problem.message },
      ]);
    }
    await this.requireFreeShortcut(shortcut, existing.ownerUserId, visibility, id);

    await this.db.client.cannedReply.update({
      where: { id },
      data: { shortcut, body, visibility },
    });
    return this.list();
  }

  /** Archives it. Never deletes: a reply that has been sent has messages pointing at it. */
  async archive(id: string) {
    const principal = tenantContext.require('cannedReplies.archive');
    const existing = await this.row(id);
    if (existing.visibility === 'private' && existing.ownerUserId !== principal.actorId) {
      throw AppError.notFound('Canned reply');
    }
    await this.db.client.cannedReply.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return this.list();
  }

  /**
   * The wording behind a shortcut, for the send path.
   *
   * Returns `null` rather than throwing for a reply this person cannot use, because the caller's
   * refusal is about the **message** — "that shortcut is not one of yours" is a validation error
   * on a field, not a 404 about a resource nobody asked for directly.
   */
  async bodyFor(id: string): Promise<string | null> {
    const principal = tenantContext.require('cannedReplies.bodyFor');
    const row = await this.db.client.cannedReply.findFirst({
      where: {
        id,
        deletedAt: null,
        AND: [
          {
            OR: [{ visibility: 'shared' }, { visibility: 'private', ownerUserId: principal.actorId }],
          },
        ],
      },
      select: { body: true },
    });
    return row?.body ?? null;
  }

  /**
   * Records that one was actually sent.
   *
   * `increment` rather than a read and a write: two agents sending the same reply in the same
   * second is the ordinary case, and the read-then-write version loses one of them — the lesson the
   * scoring queue paid for with a row lock and the status receipts with a conditional update. A
   * counter needs neither, because `+ 1` is already atomic.
   */
  async recordUse(id: string): Promise<void> {
    await this.db.client.cannedReply.updateMany({
      where: { id },
      data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }

  private async row(id: string) {
    const row = await this.db.client.cannedReply.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, shortcut: true, body: true, visibility: true, ownerUserId: true },
    });
    if (!row) throw AppError.notFound('Canned reply');
    return row;
  }

  /**
   * Refuses a shortcut already in use, with the sentence that says whose.
   *
   * The partial unique would refuse it anyway — as a raw constraint violation, which is a 500 on a
   * mistake somebody can fix. The same reasoning as the WhatsApp number collision check.
   */
  private async requireFreeShortcut(
    shortcut: string,
    ownerUserId: string,
    visibility: CannedReplyVisibility,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await this.db.client.cannedReply.findFirst({
      where: {
        shortcut,
        deletedAt: null,
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
        // A shared reply clashes with anything using the shortcut; a private one only with this
        // person's own, which is what makes two agents' `/thanks` possible.
        ...(visibility === 'shared' ? {} : { ownerUserId }),
      },
      select: { visibility: true },
    });
    if (clash !== null) {
      throw AppError.validation('That shortcut is taken', [
        {
          field: 'shortcut',
          code: 'SHORTCUT_TAKEN',
          message:
            clash.visibility === 'shared'
              ? `${shortcut} is already a shared reply in this workspace.`
              : `You already have a reply on ${shortcut}.`,
        },
      ]);
    }
  }

  private present(row: {
    id: string;
    shortcut: string;
    body: string;
    visibility: string;
    usageCount: number;
    lastUsedAt: Date | null;
    owner: { userId: string; user: { name: string } };
  }) {
    return {
      id: row.id,
      shortcut: row.shortcut,
      body: row.body,
      visibility: row.visibility,
      owner: { id: row.owner.userId, name: row.owner.user.name },
      /** Times **sent**, which is what orders the picker. */
      usageCount: row.usageCount,
      lastUsedAt: row.lastUsedAt,
    };
  }
}

/** Exported so the DTO and the tests name one list. */
export { CANNED_REPLY_VISIBILITIES };
