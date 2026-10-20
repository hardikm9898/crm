'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorNotice } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { markConversationRead, retryMessage, sendAttachment, sendMessage } from '../actions';

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

/**
 * The composer (`FR-WA-1`).
 *
 * What it offers is decided by the API's own answer, not by arithmetic repeated here: inside the
 * 24-hour window there is a text box and an optional template; outside it there is **only** the
 * template picker, and the sentence the API wrote says why. A text box that was enabled and then
 * refused is the shape of bug this split exists to prevent.
 *
 * The template's variables are rendered as boxes the agent can fill, pre-filled from the preview
 * the API resolved — because a template that cannot be sent for want of a city is one an agent can
 * finish in two seconds if the screen lets them.
 */
export function Composer({
  conversationId,
  windowIsOpen,
  windowSummary,
  templates,
}: {
  conversationId: string;
  windowIsOpen: boolean;
  windowSummary: string;
  templates: readonly {
    id: string;
    name: string;
    language: string;
    category: string;
    preview: string;
    variables: number[];
    resolved: Record<string, string>;
    missing: string[];
  }[];
}) {
  const [state, submit, pending] = useActionState(sendMessage, IDLE);
  const [templateId, setTemplateId] = useState('');
  const chosen = templates.find((template) => template.id === templateId) ?? null;

  return (
    <form action={submit} className="flex flex-col gap-2" data-composer={conversationId}>
      <input type="hidden" name="conversationId" value={conversationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      {!windowIsOpen && (
        <p className="text-xs text-[var(--color-warning)]" data-composer-closed={conversationId}>
          {windowSummary}
        </p>
      )}

      {templates.length > 0 && (
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Template
          <select
            name="templateId"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            data-template-picker={conversationId}
          >
            {/* Only offered while a free reply is allowed: outside the window there is nothing
                else to choose, and an option that cannot be used is a dead end. */}
            {windowIsOpen && <option value="">Type a reply instead</option>}
            {!windowIsOpen && <option value="">Choose an approved template…</option>}
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} ({template.language})
              </option>
            ))}
          </select>
        </label>
      )}

      {chosen === null ? (
        <textarea
          name="body"
          rows={3}
          disabled={!windowIsOpen}
          defaultValue={state.status === 'error' ? (state.values?.['body'] ?? '') : ''}
          placeholder={
            windowIsOpen
              ? 'Write a reply…'
              : 'The 24-hour window has closed — choose a template above.'
          }
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)] disabled:opacity-60"
          data-composer-body={conversationId}
        />
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] px-3 py-2">
          <p className="text-sm" data-template-preview={chosen.id}>
            {chosen.preview}
          </p>
          {chosen.variables.map((index) => (
            <label
              key={index}
              className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]"
            >
              {`{{${index}}}`}
              <input
                name={`variable-${index}`}
                defaultValue={chosen.resolved[String(index)] ?? ''}
                placeholder={
                  chosen.missing.includes(String(index))
                    ? 'Their record has nothing for this — type it'
                    : ''
                }
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)]"
                data-template-variable={`${chosen.id}-${index}`}
              />
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || (!windowIsOpen && chosen === null)}>
          {pending ? 'Sending…' : chosen === null ? 'Send' : 'Send template'}
        </Button>
        <span className="text-xs text-[var(--color-text-muted)]">
          {windowIsOpen ? windowSummary : 'Templates only'}
        </span>
      </div>
    </form>
  );
}

/**
 * "Try again", on a message WhatsApp refused.
 *
 * On the message's own row rather than at the bottom of the thread: the thing somebody wants to
 * retry is the thing they are looking at, and a retry writes to the **same** row — a second one
 * would read as the customer having been messaged twice.
 */
export function RetryForm({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const [state, submit, pending] = useActionState(retryMessage, IDLE);
  return (
    <form action={submit} className="mt-1 flex items-center gap-2" data-retry={messageId}>
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="messageId" value={messageId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Trying…' : 'Try again'}
      </Button>
    </form>
  );
}

/**
 * The attachment composer (`FR-WA-3`).
 *
 * Its own form, beside the reply box rather than inside it: a file and a typed reply are two
 * messages on WhatsApp, and one form that sent either depending on which field was filled is the
 * kind of ambiguity that sends the wrong one. It is also why the file input is scoped to this
 * form — a second `name="caption"` on the page would make every field selector ambiguous, which a
 * browser check has already paid for once.
 *
 * Offered only while the 24-hour window is open, because a file is not a template and Meta refuses
 * one outside it: a button that was enabled and then refused is the thing the split exists to
 * prevent.
 */
export function AttachmentForm({
  conversationId,
  windowIsOpen,
  limits,
}: {
  conversationId: string;
  windowIsOpen: boolean;
  limits: string;
}) {
  const [state, submit, pending] = useActionState(sendAttachment, IDLE);
  const [chosen, setChosen] = useState<string | null>(null);

  if (!windowIsOpen) return null;
  return (
    <form action={submit} className="flex flex-col gap-2" data-attachment-form={conversationId}>
      <input type="hidden" name="conversationId" value={conversationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'error' && state.fieldErrors?.['file'] && (
        <p className="text-xs text-[var(--color-danger)]" data-attachment-field-error>
          {state.fieldErrors['file']}
        </p>
      )}
      {/* `w-full min-w-0`: a file input has an intrinsic width of its own — the button plus the
          longest filename it has held — and at 375 px that was 4 px of sideways scroll on the whole
          page, which only a browser check at phone width finds. */}
      <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        Send a file
        <input
          type="file"
          name="file"
          onChange={(event) => setChosen(event.target.files?.[0]?.name ?? null)}
          className="w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          data-attachment-input={conversationId}
        />
      </label>
      {/* The chosen name, printed: a refused submission cannot restore a file input, so the one
          thing this screen can honestly say is which file is currently attached. */}
      {chosen !== null && (
        <p className="break-all text-xs text-[var(--color-text-muted)]" data-attachment-chosen>
          {chosen}
        </p>
      )}
      <input
        name="caption"
        defaultValue={state.status === 'error' ? (state.values?.['caption'] ?? '') : ''}
        placeholder="A caption, if you want one"
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
        data-attachment-caption={conversationId}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Sending…' : 'Send file'}
        </Button>
        <span className="text-xs text-[var(--color-text-muted)]">{limits}</span>
      </div>
    </form>
  );
}
