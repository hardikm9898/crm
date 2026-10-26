import { PERMISSIONS } from '@leados/shared';

/**
 * What the engine may do (`FR-AUT-6`).
 *
 * A workflow is the **workspace's** standing instruction, not a member's — it has no `actorId`,
 * and `canAct` defaults an absent scope to `own`, which compares a row against a person. So the
 * engine's principal holds its permissions at organization scope; without them every action that
 * goes through a service answered "Lead not found", which is the data scope working exactly as it
 * should against a principal that is nobody.
 *
 * The list is **enumerated rather than wholesale**, and that is the point: granting the engine the
 * whole catalogue would make "what can a workflow do to this workspace?" unanswerable, and would
 * silently widen the moment somebody adds a permission for an unrelated feature. Adding an action
 * that needs something new is a line here, which is a moment where a person decides.
 *
 * Deliberately absent: everything that is not a write a workflow performs —
 * `automation:manage` (a workflow cannot edit workflows), `user:manage`, `role:manage`,
 * `billing:*`, `settings:manage`, and every `*:delete`. A workflow that could delete a lead is a
 * workflow one typo away from deleting a pipeline's worth of them.
 */
export const ENGINE_PERMISSIONS: readonly string[] = [
  // Reading the lead a run is about, and the facts a condition compares.
  PERMISSIONS.LEAD_READ,
  // `change_status`, `change_stage`, `add_tag`.
  PERMISSIONS.LEAD_UPDATE,
  // `assign`.
  PERMISSIONS.LEAD_ASSIGN,
  // `create_task`. `task:manage_others` because a workflow creates a follow-up **for** the
  // lead's owner, which is somebody else's task by definition.
  PERMISSIONS.TASK_READ,
  PERMISSIONS.TASK_MANAGE,
  PERMISSIONS.TASK_MANAGE_OTHERS,
  // `send_whatsapp_template`.
  PERMISSIONS.CONVERSATION_READ,
  PERMISSIONS.CONVERSATION_REPLY,
];
