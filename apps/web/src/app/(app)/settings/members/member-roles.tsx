'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { setMemberRoles, updateMemberStatus } from '../actions';

/**
 * Changing what one person may do.
 *
 * The whole set of roles is submitted, because that is what the API takes and what the person
 * editing actually means. The API refuses the two changes that would lock a workspace out — removing
 * the last administrator, or suspending yourself — so this screen offers them and reports the
 * refusal rather than trying to predict it (docs/security.md §4).
 */
export function MemberRoles({
  userId,
  name,
  status,
  isSelf,
  assignedRoleIds,
  roles,
}: {
  userId: string;
  name: string;
  status: string;
  isSelf: boolean;
  assignedRoleIds: string[];
  roles: { id: string; name: string }[];
}) {
  const [rolesState, submitRoles, rolesPending] = useActionState(setMemberRoles, IDLE);
  const [statusState, submitStatus, statusPending] = useActionState(updateMemberStatus, IDLE);
  const [selected, setSelected] = useState<string[]>(assignedRoleIds);
  const [editing, setEditing] = useState(false);

  const assignedNames = roles
    .filter((role) => assignedRoleIds.includes(role.id))
    .map((role) => role.name);

  if (!editing) {
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="text-sm">{assignedNames.join(', ') || 'No role'}</span>
        <div className="flex items-center gap-2">
          <Button variant="quiet" onClick={() => setEditing(true)}>
            Change
          </Button>
          {!isSelf && (
            <form action={submitStatus}>
              <input type="hidden" name="userId" value={userId} />
              <input
                type="hidden"
                name="status"
                value={status === 'suspended' ? 'active' : 'suspended'}
              />
              <Button type="submit" variant="quiet" pending={statusPending}>
                {status === 'suspended' ? 'Restore access' : 'Suspend'}
              </Button>
            </form>
          )}
        </div>
        {(rolesState.status !== 'idle' || statusState.status !== 'idle') && (
          <Outcome state={rolesState.status !== 'idle' ? rolesState : statusState} />
        )}
      </div>
    );
  }

  return (
    <form action={submitRoles} className="flex flex-col items-start gap-2">
      <input type="hidden" name="userId" value={userId} />
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">Roles for {name}</legend>
        {roles.map((role) => (
          <label key={role.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="roleIds"
              value={role.id}
              checked={selected.includes(role.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, role.id]
                    : current.filter((id) => id !== role.id),
                )
              }
            />
            {role.name}
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-2">
        <Button type="submit" pending={rolesPending}>
          {rolesPending ? 'Saving…' : 'Save roles'}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setSelected(assignedRoleIds);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
      {rolesState.status === 'error' && <Outcome state={rolesState} />}
    </form>
  );
}

function Outcome({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <span
      role={state.status === 'error' ? 'alert' : 'status'}
      className={`text-xs ${
        state.status === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
      }`}
    >
      {state.message}
    </span>
  );
}
