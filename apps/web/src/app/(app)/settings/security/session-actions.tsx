'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { revokeAllSessions, revokeSession } from './actions';

/**
 * Ending one session, or all of them.
 *
 * "Sign out everywhere" ends this device's session too — it has to, or the feature would be useless
 * after a stolen laptop — so it confirms first and then sends the person to sign-in rather than
 * leaving a shell that 401s on its next request.
 */
export function SessionActions({ scope, sessionId }: { scope: 'one' | 'all'; sessionId?: string }) {
  const router = useRouter();
  const [state, submit, pending] = useActionState(revokeSession, IDLE);
  const [allPending, startAll] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (scope === 'all') {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="danger"
          pending={allPending}
          onClick={() => {
            if (!window.confirm('Sign out on every device, including this one?')) return;
            startAll(async () => {
              const result = await revokeAllSessions();
              if (result.status === 'error') {
                setError(result.message);
                return;
              }
              await fetch('/api/session', { method: 'DELETE' });
              router.replace('/login');
            });
          }}
        >
          {allPending ? 'Signing out…' : 'Sign out everywhere'}
        </Button>
        {error && (
          <span role="alert" className="text-xs text-[var(--color-danger)]">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <form action={submit} className="flex items-center justify-end gap-2">
      <input type="hidden" name="sessionId" value={sessionId ?? ''} />
      {state.status === 'error' && (
        <span role="alert" className="text-xs text-[var(--color-danger)]">
          {state.message}
        </span>
      )}
      <Button type="submit" variant="quiet" pending={pending}>
        {pending ? 'Ending…' : 'End session'}
      </Button>
    </form>
  );
}
