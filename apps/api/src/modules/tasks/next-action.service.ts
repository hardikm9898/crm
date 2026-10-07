import { Injectable } from '@nestjs/common';
import type { TransactionClient } from '../../infra/outbox/outbox.service.js';

/**
 * `leads.next_action_at`, `leads.next_action_task_id` and `leads.open_tasks_count` (`FR-TSK-4`).
 *
 * **Recomputed from `tasks`, never incremented.** The columns have existed since step 1 with
 * nothing writing them, and the temptation on every task write is `{ increment: 1 }` — which is
 * wrong the first time two writers read the same "before" value. Scoring already paid for that
 * once, with two jobs reading `score = 0` and both writing 15. A count is cheaper to be wrong
 * about than money, but "this lead has no next action" is the one list a manager works from, and a
 * drifted count puts leads on it that are fine and keeps leads off it that are not.
 *
 * So: take the row lock, read the open tasks, write the three columns. One indexed read over
 * `tasks_lead_open`, which is a handful of rows.
 *
 * The next action is the **soonest-due open task**, with the lowest id breaking a tie so the answer
 * is stable: two tasks due at the same minute must not make the pointer flip between recomputes,
 * because `FR-TSK-4` wants one next action and a screen that renames it every refresh is worse
 * than none.
 */
@Injectable()
export class NextActionService {
  /**
   * Takes the lead's row lock **before** the task write, in lead-id order.
   *
   * This is not belt and braces; without it, two tasks created on the same lead at the same instant
   * deadlock and both callers get a 500.
   *
   * Inserting a task takes a `FOR KEY SHARE` lock on the lead it references — Postgres does that
   * for every foreign key, to stop the parent disappearing underneath the child. So by the time
   * the recompute asks for `FOR UPDATE`, *both* transactions already hold KEY SHARE on the same
   * lead and each is waiting for the other to release it. Postgres detects the cycle and kills one
   * of them.
   *
   * Acquiring `FOR UPDATE` first makes the second transaction queue on the lock instead: no cycle,
   * no deadlock, and the recompute that follows reads a state nobody else is changing. The lock is
   * taken in a deterministic order for the same reason — a write touching two leads must not be
   * able to grab them in the opposite order to another write.
   */
  async lockLeads(
    tx: TransactionClient,
    organizationId: string,
    leadIds: readonly (string | null | undefined)[],
  ): Promise<void> {
    const unique = [
      ...new Set(leadIds.filter((id): id is string => typeof id === 'string')),
    ].sort();
    for (const leadId of unique) {
      await tx.$queryRaw`
        SELECT id FROM leads
         WHERE organization_id = ${organizationId}::uuid AND id = ${leadId}::uuid
         FOR UPDATE
      `;
    }
  }

  /**
   * Refreshes every lead a task write could have touched.
   *
   * Takes a set because completing a task with a follow-up moves two tasks on the same lead, and a
   * reassignment can move a task between subjects — recomputing once per affected lead keeps the
   * caller from having to reason about which write won.
   */
  async refreshLeads(
    tx: TransactionClient,
    organizationId: string,
    leadIds: readonly (string | null | undefined)[],
  ): Promise<void> {
    const unique = [...new Set(leadIds.filter((id): id is string => typeof id === 'string'))];
    for (const leadId of unique) await this.refreshLead(tx, organizationId, leadId);
  }

  private async refreshLead(
    tx: TransactionClient,
    organizationId: string,
    leadId: string,
  ): Promise<void> {
    // The lock first, then the read. Reading before locking is how two concurrent task writes
    // compute the same "before" state and one of them loses.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM leads
       WHERE organization_id = ${organizationId}::uuid AND id = ${leadId}::uuid
       FOR UPDATE
    `;
    if (locked.length === 0) return;

    const [row] = await tx.$queryRaw<
      { open: bigint; next_id: string | null; next_at: Date | null }[]
    >`
      SELECT count(*) AS open,
             (SELECT id FROM tasks
               WHERE organization_id = ${organizationId}::uuid
                 AND lead_id = ${leadId}::uuid
                 AND deleted_at IS NULL
                 AND status IN ('pending', 'in_progress')
               ORDER BY due_at ASC, id ASC
               LIMIT 1) AS next_id,
             (SELECT min(due_at) FROM tasks
               WHERE organization_id = ${organizationId}::uuid
                 AND lead_id = ${leadId}::uuid
                 AND deleted_at IS NULL
                 AND status IN ('pending', 'in_progress')) AS next_at
        FROM tasks
       WHERE organization_id = ${organizationId}::uuid
         AND lead_id = ${leadId}::uuid
         AND deleted_at IS NULL
         AND status IN ('pending', 'in_progress')
    `;

    await tx.$executeRaw`
      UPDATE leads
         SET open_tasks_count = ${Number(row?.open ?? 0)},
             next_action_task_id = ${row?.next_id ?? null}::uuid,
             next_action_at = ${row?.next_at ?? null},
             updated_at = now()
       WHERE organization_id = ${organizationId}::uuid AND id = ${leadId}::uuid
    `;
  }
}
