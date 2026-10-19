'use client';

import { useActionState } from 'react';
import { Button, ErrorNotice } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { markConversationRead } from '../actions';

/**
 * "Mark as read", and nothing else.
 *
 * The confirmation is not read from this component's own state: a successful mark revalidates the
 * screen, the row loses its unread badge and the component re-renders — the re-rendered server tree
 * is the confirmation, and it survives a refresh, which `useActionState` does not. A refusal keeps
 * the row, so its notice stays where somebody can read it.
 */
export function MarkReadForm({ conversationId }: { conversationId: string }) {
  const [state, submit, pending] = useActionState(markConversationRead, IDLE);
  return (
    <form action={submit} className="flex flex-col gap-2" data-mark-read={conversationId}>
      <input type="hidden" name="conversationId" value={conversationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Marking…' : 'Mark as read'}
      </Button>
    </form>
  );
}
