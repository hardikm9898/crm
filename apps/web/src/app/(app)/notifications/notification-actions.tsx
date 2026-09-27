'use client';

import { useActionState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { markAllRead, markRead } from './actions';

export function MarkRead({ notificationId }: { notificationId: string }) {
  const [state, submit, pending] = useActionState(markRead, IDLE);

  return (
    <form action={submit} className="flex items-center gap-2">
      <input type="hidden" name="notificationId" value={notificationId} />
      {state.status === 'error' && (
        <span role="alert" className="text-xs text-[var(--color-danger)]">
          {state.message}
        </span>
      )}
      <Button type="submit" variant="quiet" pending={pending}>
        {pending ? 'Marking…' : 'Mark read'}
      </Button>
    </form>
  );
}

export function MarkAllRead() {
  const [pending, start] = useTransition();

  return (
    <Button variant="secondary" pending={pending} onClick={() => start(() => void markAllRead())}>
      {pending ? 'Marking…' : 'Mark all read'}
    </Button>
  );
}
