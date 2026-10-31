'use client';

import { useActionState } from 'react';
import { Button, ErrorNotice } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { archiveCannedReply, createCannedReply, updateCannedReply } from '../actions';

/**
 * A new canned reply.
 *
 * The shortcut box asks for words, not punctuation: the API adds the slash and hyphenates, so
 * `Price List` becomes `/price-list`. Demanding the exact form is how a feature goes unused, and
 * doing the cleaning here as well would be a second answer to one question.
 */
export function NewReplyForm() {
  const [state, submit, pending] = useActionState(createCannedReply, IDLE);
  const echo = (field: string) => (state.status === 'error' ? (state.values?.[field] ?? '') : '');
  return (
    <form action={submit} className="flex flex-col gap-2" data-new-reply>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'error' && state.fieldErrors?.['shortcut'] && (
        <p className="text-xs text-[var(--color-danger)]" data-shortcut-error>
          {state.fieldErrors['shortcut']}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Shortcut
          <input
            name="shortcut"
            defaultValue={echo('shortcut')}
            placeholder="Price list"
            className="w-44 min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            data-reply-shortcut
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Who can use it
          <select
            key={`visibility-${echo('visibility')}`}
            name="visibility"
            defaultValue={echo('visibility') || 'shared'}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            data-reply-visibility
          >
            <option value="shared">Everybody here</option>
            <option value="private">Only me</option>
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        What it says
        <textarea
          name="body"
          rows={2}
          defaultValue={echo('body')}
          placeholder="Our current price list is attached. Shall I book a site visit?"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          data-reply-body
        />
      </label>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Add reply'}
        </Button>
      </div>
    </form>
  );
}

/**
 * One reply, as a row.
 *
 * The shortcut is printed as **text** above its editor, not only inside an input: a settings list
 * whose values live only in form fields is unreadable and unassertable — seven rows of identical
 * "Body" labels, which the payment methods screen paid for.
 */
export function ReplyRow({
  reply,
}: {
  reply: {
    id: string;
    shortcut: string;
    body: string;
    visibility: string;
    owner: { name: string };
    usageCount: number;
  };
}) {
  const [editState, edit, editing] = useActionState(updateCannedReply, IDLE);
  const [archiveState, archive, archiving] = useActionState(archiveCannedReply, IDLE);
  const failure =
    editState.status === 'error'
      ? editState
      : archiveState.status === 'error'
        ? archiveState
        : null;
  return (
    <li
      className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2"
      data-reply={reply.id}
    >
      {failure && <ErrorNotice>{failure.message}</ErrorNotice>}
      <div className="flex flex-wrap items-baseline gap-2">
        <code className="text-sm font-semibold" data-reply-name={reply.id}>
          {reply.shortcut}
        </code>
        <span className="text-xs text-[var(--color-text-muted)]" data-reply-meta={reply.id}>
          {reply.visibility === 'private' ? `Only ${reply.owner.name}` : 'Shared'} ·{' '}
          {/* Times **sent**, which is what orders the picker. A count of clicks would promote
              whatever is easiest to misclick. */}
          {reply.usageCount === 1 ? 'sent once' : `sent ${reply.usageCount} times`}
        </span>
      </div>
      <form action={edit} className="flex flex-col gap-2">
        <input type="hidden" name="replyId" value={reply.id} />
        <textarea
          name="body"
          rows={2}
          defaultValue={
            editState.status === 'error' ? (editState.values?.['body'] ?? reply.body) : reply.body
          }
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          data-reply-edit={reply.id}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="secondary" disabled={editing}>
            {editing ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
      <form action={archive}>
        <input type="hidden" name="replyId" value={reply.id} />
        <Button type="submit" variant="secondary" disabled={archiving}>
          {archiving ? 'Removing…' : 'Remove'}
        </Button>
      </form>
    </li>
  );
}
