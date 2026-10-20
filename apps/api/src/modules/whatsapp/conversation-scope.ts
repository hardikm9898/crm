import type { DataScopeService } from '../../infra/authz/data-scope.service.js';

/**
 * Which conversations a caller may act on: theirs, **plus anything nobody has claimed**
 * (`FR-WA-7`).
 *
 * In its own module because four services need it — the reader, the sender, the attachment store
 * and the ownership changes — and an import between two Nest services is the ESM cycle that is a
 * `ReferenceError` at boot. A pure function taking the scope service rather than a method on one
 * of them, for the same reason.
 *
 * **Why the widening.** A conversation carries no branch or team column, so every scope narrower
 * than the whole workspace resolves to `assigned_user_id = me`. Stopping there made a *shared*
 * inbox unreadable by the people it is for: a sales executive holds `conversation:read` and
 * `conversation:reply` at **own** scope, a workspace with no assignment rule leaves every incoming
 * conversation unassigned, and so a new customer's first message was visible to nobody but an
 * owner or an admin — the conversations at the greatest risk of never being answered were the ones
 * the inbox hid. That is the `/my/today` lesson one module later, and it was found by an e2e test
 * driving a second real member rather than by reading the code, whose comment had claimed the
 * right behaviour while the code did the other thing.
 *
 * The narrow reading is the one that cannot be defended: a conversation nobody owns is precisely
 * the one somebody has to be able to pick up. Assignment, transfer and the audit trail are what
 * make picking it up accountable.
 *
 * Expressed under `AND` rather than as a bare `OR`, so it composes with any `OR` a later filter
 * needs: two `OR` keys at one level of a Prisma `where` silently replace each other.
 *
 * `null` means nothing can match, which the caller answers as a 404 — never as "everything".
 */
export function conversationScopeWhere(
  scopes: DataScopeService,
  permission: string,
  base: Record<string, unknown>,
): Record<string, unknown> | null {
  const filter = scopes.filterFor(permission, { userColumn: 'assignedUserId' });
  if (filter.kind === 'all') return base;
  // `none` means this principal has no ownership column to be scoped by at all — which for a
  // conversation means they can never be given one, not that every conversation is theirs.
  if (filter.kind === 'none') return null;
  return { ...base, AND: [{ OR: [filter.where, { assignedUserId: null }] }] };
}
