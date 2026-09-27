'use client';

import { useActionState } from 'react';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { inviteMember } from '../actions';

/**
 * Invites a colleague.
 *
 * The role is required because an invitation has to grant something specific — there is no default
 * role, and "we'll sort out permissions later" is how a workspace ends up with everyone an
 * administrator.
 */
export function InviteForm({ roles }: { roles: { id: string; name: string }[] }) {
  const [state, submit, pending] = useActionState(inviteMember, IDLE);
  const fieldError = (field: string): string | undefined =>
    state.status === 'error' ? state.fieldErrors?.[field] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-4">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
        <Field label="Email address" hint={fieldError('email')}>
          <input
            type="email"
            name="email"
            required
            autoComplete="off"
            className={controlClassName}
          />
        </Field>
        <Field label="Role" hint={fieldError('roleId')}>
          <select name="roleId" required defaultValue="" className={controlClassName}>
            <option value="" disabled>
              Choose a role
            </option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" pending={pending}>
          {pending ? 'Sending…' : 'Send invitation'}
        </Button>
      </div>
    </form>
  );
}
