'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorNotice } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import {
  addConversationNote,
  assignConversation,
  claimConversation,
  closeConversation,
  markConversationRead,
  releaseConversation,
  reopenConversation,
  retryMessage,
  sendAttachment,
  sendMessage,
  setConversationTags,
  snoozeConversation,
  transferConversation,
} from '../actions';

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
  cannedReplies = [],
}: {
  conversationId: string;
  windowIsOpen: boolean;
  windowSummary: string;
  /** The shortcuts this person may use, most-used first (`FR-WA-7`). */
  cannedReplies?: readonly { id: string; shortcut: string; body: string }[];
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
  const [body, setBody] = useState(state.status === 'error' ? (state.values?.['body'] ?? '') : '');
  // Which canned reply the text came from, so the count means "times sent". Cleared the moment
  // somebody types past it: a count that credited a reply for a message nobody recognised would be
  // worse than no count.
  const [usedReply, setUsedReply] = useState<string | null>(null);
  const chosen = templates.find((template) => template.id === templateId) ?? null;
  // Offered while the shortcut is still being typed, and only when the message **is** the shortcut:
  // "call me on /price-list" is a sentence, which is the same whole-message rule the opt-out
  // keywords use. Mirrored from `matchingShortcuts` in `@leados/shared`, which this app may not
  // import at runtime — a spec reconciles the two.
  const typed = body.trim().toLowerCase();
  const suggestions =
    typed.startsWith('/') && !/\s/u.test(typed)
      ? cannedReplies.filter((reply) => reply.shortcut.startsWith(typed)).slice(0, 5)
      : [];

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
        <>
          <textarea
            name="body"
            rows={3}
            disabled={!windowIsOpen}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              // A canned reply is edited before sending more often than not; the credit survives
              // that, and goes only when the text no longer has the reply's wording in it at all.
              setUsedReply((current) => {
                if (current === null) return null;
                const reply = cannedReplies.find((candidate) => candidate.id === current);
                return reply && event.target.value.includes(reply.body.slice(0, 12))
                  ? current
                  : null;
              });
            }}
            placeholder={
              windowIsOpen
                ? 'Write a reply, or type / for a saved one…'
                : 'The 24-hour window has closed — choose a template above.'
            }
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)] disabled:opacity-60"
            data-composer-body={conversationId}
          />
          <input type="hidden" name="cannedReplyId" value={usedReply ?? ''} />
          {suggestions.length > 0 && (
            <ul className="flex flex-col gap-1" data-reply-suggestions={conversationId}>
              {suggestions.map((reply) => (
                <li key={reply.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setBody(reply.body);
                      setUsedReply(reply.id);
                    }}
                    className="w-full rounded-md border border-[var(--color-border)] px-2 py-1 text-left text-xs text-[var(--color-text-muted)]"
                    data-reply-suggestion={reply.shortcut}
                  >
                    <code className="font-semibold">{reply.shortcut}</code>{' '}
                    <span className="break-words">{reply.body.slice(0, 80)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
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

/**
 * Who has this conversation open, and the one button about it (`FR-WA-7`).
 *
 * The sentence is the **API's**, through `conversationLock` in `@leados/shared` — the same
 * function the write path calls — so the warning an agent reads and the state the server holds
 * cannot disagree. It is a warning and not a block: the button to take it over says so, because a
 * refusal here means a customer waits until somebody else's five minutes run out.
 */
export function LockBanner({
  conversationId,
  lock,
}: {
  conversationId: string;
  lock: { held: boolean; mine: boolean; message: string | null };
}) {
  const [claimState, claim, claiming] = useActionState(claimConversation, IDLE);
  const [releaseState, release, releasing] = useActionState(releaseConversation, IDLE);
  const error = claimState.status === 'error' ? claimState : releaseState.status === 'error' ? releaseState : null;

  return (
    <div className="flex flex-col gap-2" data-lock-banner={conversationId}>
      {error && <ErrorNotice>{error.message}</ErrorNotice>}
      {lock.message !== null && (
        <p
          className={`text-xs ${lock.mine ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-warning)]'}`}
          data-lock-message={conversationId}
        >
          {lock.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {lock.mine ? (
          <form action={release}>
            <input type="hidden" name="conversationId" value={conversationId} />
            <Button type="submit" variant="secondary" disabled={releasing}>
              {releasing ? 'Letting go…' : 'Let go'}
            </Button>
          </form>
        ) : (
          <form action={claim}>
            <input type="hidden" name="conversationId" value={conversationId} />
            <Button type="submit" variant="secondary" disabled={claiming}>
              {claiming ? 'Opening…' : lock.held ? 'Take over' : "I'm on this"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Assignment, transfer, close, reopen and snooze — the things somebody does *to* a conversation.
 *
 * One component because they are one row of controls on the screen, and **separate forms** because
 * each is a different act with a different body: one form that did whichever field was filled is
 * the ambiguity that sends the wrong one. Every field selector is scoped to its own form for the
 * same reason a payments panel's `name="note"` once broke a deal check.
 */
export function ConversationActions({
  conversationId,
  status,
  assignedToId,
  members,
  snoozeOptions,
}: {
  conversationId: string;
  status: string;
  assignedToId: string | null;
  members: readonly { userId: string; name: string }[];
  snoozeOptions: readonly { label: string; until: string }[];
}) {
  const [assignState, assign, assigning] = useActionState(assignConversation, IDLE);
  const [transferState, transfer, transferring] = useActionState(transferConversation, IDLE);
  const [closeState, close, closing] = useActionState(closeConversation, IDLE);
  const [reopenState, reopen, reopening] = useActionState(reopenConversation, IDLE);
  const [snoozeState, snooze, snoozing] = useActionState(snoozeConversation, IDLE);
  const failure =
    [assignState, transferState, closeState, reopenState, snoozeState].find(
      (state) => state.status === 'error',
    ) ?? null;
  // Echoed, so a refused assignment does not lose the person somebody picked — and `key` with it,
  // because a `<select>` comes back from a refusal through nothing else. Third time this product
  // has paid for that.
  const echoedAssignee =
    assignState.status === 'error' ? (assignState.values?.['assignedUserId'] ?? '') : (assignedToId ?? '');

  return (
    <div className="flex flex-col gap-3" data-conversation-actions={conversationId}>
      {failure && <ErrorNotice>{failure.message}</ErrorNotice>}

      <form action={assign} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Owner
          <select
            key={`assignee-${echoedAssignee}`}
            name="assignedUserId"
            defaultValue={echoedAssignee}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            data-assign-picker={conversationId}
          >
            {/* "Nobody" is a real choice: a conversation in the pool is visible to everybody who
                can read it, and is what somebody going on leave needs. */}
            <option value="">Nobody — back in the pool</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={assigning}>
          {assigning ? 'Saving…' : 'Set owner'}
        </Button>
      </form>

      <form action={transfer} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Hand to
          <select
            name="toUserId"
            defaultValue=""
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            data-transfer-picker={conversationId}
          >
            <option value="">Choose a colleague…</option>
            {members
              .filter((member) => member.userId !== assignedToId)
              .map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Why
          <input
            name="transferNote"
            defaultValue={
              transferState.status === 'error' ? (transferState.values?.['transferNote'] ?? '') : ''
            }
            placeholder="On leave — she expects a call Monday"
            className="w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            data-transfer-note={conversationId}
          />
        </label>
        <Button type="submit" variant="secondary" disabled={transferring}>
          {transferring ? 'Handing over…' : 'Transfer'}
        </Button>
      </form>

      <div className="flex flex-wrap items-end gap-2">
        {status === 'closed' ? (
          <form action={reopen}>
            <input type="hidden" name="conversationId" value={conversationId} />
            <Button type="submit" variant="secondary" disabled={reopening}>
              {reopening ? 'Opening…' : 'Reopen'}
            </Button>
          </form>
        ) : (
          <>
            <form action={close} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="conversationId" value={conversationId} />
              <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Closing note
                <input
                  name="closeNote"
                  defaultValue={
                    closeState.status === 'error' ? (closeState.values?.['closeNote'] ?? '') : ''
                  }
                  placeholder="Booked a site visit"
                  className="w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
                  data-close-note={conversationId}
                />
              </label>
              <Button type="submit" variant="secondary" disabled={closing}>
                {closing ? 'Closing…' : 'Close'}
              </Button>
            </form>
            <form action={snooze} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="conversationId" value={conversationId} />
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Come back
                <select
                  name="until"
                  defaultValue={snoozeOptions[0]?.until ?? ''}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
                  data-snooze-picker={conversationId}
                >
                  {snoozeOptions.map((option) => (
                    <option key={option.until} value={option.until}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="secondary" disabled={snoozing}>
                {snoozing ? 'Putting aside…' : 'Snooze'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Internal notes, and the colleagues a note names (`FR-WA-7`).
 *
 * The mention picker submits **ids** while the box carries whatever somebody typed: a service that
 * parsed `@Asha` out of the text would tell the wrong Asha the moment a workspace has two, and the
 * mistake would be silent in the worst direction — the right person never hears about it.
 */
export function NotesPanel({
  conversationId,
  notes,
  members,
}: {
  conversationId: string;
  notes: readonly {
    id: string;
    body: string;
    author: { name: string };
    mentions: { id: string; name: string }[];
    createdAt: string;
  }[];
  members: readonly { userId: string; name: string }[];
}) {
  const [state, submit, pending] = useActionState(addConversationNote, IDLE);
  return (
    <div className="flex flex-col gap-3" data-notes-panel={conversationId}>
      <form action={submit} className="flex flex-col gap-2">
        <input type="hidden" name="conversationId" value={conversationId} />
        {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
        <textarea
          name="noteBody"
          rows={2}
          defaultValue={state.status === 'error' ? (state.values?.['noteBody'] ?? '') : ''}
          placeholder="A note for your colleagues — the customer never sees this."
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
          data-note-body={conversationId}
        />
        {members.length > 0 && (
          <fieldset className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-muted)]">
            <legend className="sr-only">Mention a colleague</legend>
            <span>Tell</span>
            {members.map((member) => (
              <label key={member.userId} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  name="mentionedUserIds"
                  value={member.userId}
                  data-mention={member.userId}
                />
                {member.name}
              </label>
            ))}
          </fieldset>
        )}
        <div>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? 'Saving…' : 'Add note'}
          </Button>
        </div>
      </form>

      {notes.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No notes on this conversation yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {notes.map((note) => (
            <li
              key={note.id}
              className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2 text-sm"
              data-note={note.id}
            >
              <p className="whitespace-pre-wrap">{note.body}</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {note.author.name}
                {note.mentions.length > 0 &&
                  ` · told ${note.mentions.map((mention) => mention.name).join(', ')}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * A conversation's tags (`FR-WA-7`).
 *
 * One comma-separated box rather than a chip editor with an add button: the API cleans whatever
 * arrives — `Site Visit, pricing` becomes `site-visit`, `pricing` — so the component that would
 * add nothing but ceremony is the one not built. The cleaned values come back in the server tree,
 * which is how somebody sees what was actually saved.
 */
export function TagsForm({
  conversationId,
  tags,
}: {
  conversationId: string;
  tags: readonly string[];
}) {
  const [state, submit, pending] = useActionState(setConversationTags, IDLE);
  return (
    <form action={submit} className="flex flex-col gap-2" data-tags-form={conversationId}>
      <input type="hidden" name="conversationId" value={conversationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {/* Printed as text, not only inside the input: a value that lives only in a form field is
          one nobody can read at a glance and nothing can assert — the payment methods lesson. */}
      <p className="text-xs text-[var(--color-text-muted)]" data-tags={conversationId}>
        {tags.length === 0 ? 'No tags yet.' : tags.join(' · ')}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Tags
          <input
            name="tags"
            defaultValue={
              state.status === 'error' ? (state.values?.['tags'] ?? tags.join(', ')) : tags.join(', ')
            }
            placeholder="site-visit, pricing"
            className="w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            data-tags-input={conversationId}
          />
        </label>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving…' : 'Save tags'}
        </Button>
      </div>
    </form>
  );
}
