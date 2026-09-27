'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { revokeInvitation } from '../actions';

/**
 * Revoking an invitation.
 *
 * Confirmed before it happens: revoking frees a seat and breaks a link someone may be about to
 * click, which is exactly the kind of quietly destructive action that should not be one stray tap
 * away (rule 14).
 */
export function InvitationActions({
  invitationId,
  email,
}: {
  invitationId: string;
  email: string;
}) {
  const [state, submit, pending] = useActionState(revokeInvitation, IDLE);

  return (
    <form
      action={submit}
      onSubmit={(event) => {
        if (!window.confirm(`Revoke the invitation sent to ${email}?`)) event.preventDefault();
      }}
      className="flex items-center justify-end gap-2"
    >
      <input type="hidden" name="invitationId" value={invitationId} />
      {state.status === 'error' && (
        <span role="alert" className="text-xs text-[var(--color-danger)]">
          {state.message}
        </span>
      )}
      <Button type="submit" variant="danger" pending={pending}>
        {pending ? 'Revoking…' : 'Revoke'}
      </Button>
    </form>
  );
}
