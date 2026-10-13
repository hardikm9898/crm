'use client';

import { useState } from 'react';
import Link from 'next/link';
import { failedCount, pendingCount, type QueuedAction } from '@/lib/action-queue';
import { formatMoney, telHref, whatsappHref } from '@/lib/lead-format';
import { defaultDue, type TaskConfig } from '@/lib/tasks';
import { describeDelta, type TodayTaskCard } from '@/lib/today';
import { completeFollowUp, rescheduleFollowUp } from '../actions';
import { useActionQueue, type Runner } from './action-queue';

/**
 * The worked part of `/today`: three sections of cards, each action one tap away.
 *
 * A client component because the actions are **queued and retried** rather than submitted — see
 * `lib/action-queue.ts` for why that matters on this screen and nowhere else. The three sections
 * are rendered here together rather than as three components so that one queue serves all of them:
 * a tap on an overdue card and a tap on a later-today card are the same kind of outstanding work,
 * and two queues would need two banners.
 *
 * The sheets are plain `<details>`/conditional markup rather than a modal: a dialog on a 375 px
 * screen covers the thing somebody is deciding about, and one that traps focus is a dialog they
 * have to dismiss before they can look at the next card.
 */

const RUNNERS: Readonly<Record<'complete' | 'reschedule', Runner>> = {
  complete: (payload) =>
    completeFollowUp({
      taskId: payload['taskId'] ?? '',
      outcomeId: payload['outcomeId'] ?? '',
      ...(payload['note'] ? { note: payload['note'] } : {}),
      ...(payload['nextTitle'] ? { nextTitle: payload['nextTitle'] } : {}),
      ...(payload['nextDueAt'] ? { nextDueAt: payload['nextDueAt'] } : {}),
    }),
  reschedule: (payload) =>
    rescheduleFollowUp({
      taskId: payload['taskId'] ?? '',
      dueAt: payload['dueAt'] ?? '',
      reasonId: payload['reasonId'] ?? '',
      ...(payload['note'] ? { note: payload['note'] } : {}),
    }),
};

export interface QueueSection {
  readonly key: 'overdue' | 'dueNow' | 'laterToday';
  readonly heading: string;
  readonly hint: string;
  readonly count: number;
  readonly items: readonly TodayTaskCard[];
  readonly truncated: boolean;
  readonly href: string;
}

export function TodayQueue({
  sections,
  config,
}: {
  sections: readonly QueueSection[];
  config: TaskConfig;
}) {
  const queue = useActionQueue(RUNNERS);
  const [open, setOpen] = useState<{ taskId: string; sheet: 'done' | 'move' } | null>(null);

  const pending = pendingCount(queue.actions);
  const failed = failedCount(queue.actions);

  return (
    <>
      {(pending > 0 || failed > 0) && (
        <div
          className="mb-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-3 text-sm"
          role="status"
          aria-live="polite"
          data-queue-banner
        >
          {pending > 0 && (
            <p data-queue-pending={String(pending)}>
              {pending === 1 ? 'Sending 1 action…' : `Sending ${pending} actions…`} It will keep
              trying if your connection drops.
            </p>
          )}
          {queue.actions
            .filter((action) => action.failure !== null)
            .map((action) => (
              <FailedAction key={action.id} action={action} queue={queue} />
            ))}
        </div>
      )}

      {sections.map((section) => (
        <section key={section.key} className="mb-5" data-section={section.key}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">
              {section.key === 'overdue' && section.count > 0 && (
                <span aria-hidden className="mr-1 text-rose-600">
                  ⚠
                </span>
              )}
              {section.heading}{' '}
              <span className="numeric font-normal" data-section-count={section.key}>
                ({section.count})
              </span>
            </h2>
            {section.truncated && (
              <Link
                href={section.href}
                className="text-sm underline"
                data-section-all={section.key}
              >
                See all {section.count}
              </Link>
            )}
          </div>
          {section.items.length === 0 ? (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text-muted)]">
              {section.key === 'overdue'
                ? 'Nothing overdue. That is the whole job, done.'
                : section.hint}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {section.items
                .filter((task) => !queue.settled.includes(task.id))
                .map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    config={config}
                    actions={queue.actions.filter((action) => action.taskId === task.id)}
                    open={open?.taskId === task.id ? open.sheet : null}
                    onOpen={(sheet) =>
                      setOpen((previous) =>
                        previous?.taskId === task.id && previous.sheet === sheet
                          ? null
                          : { taskId: task.id, sheet },
                      )
                    }
                    onEnqueue={queue.enqueue}
                    onClose={() => setOpen(null)}
                  />
                ))}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}

function FailedAction({
  action,
  queue,
}: {
  action: QueuedAction;
  queue: { retry(id: string): void; dismiss(id: string): void };
}) {
  return (
    <p className="mt-1 text-rose-700" data-queue-failed={action.taskId}>
      <strong>{action.label}</strong> could not be sent: {action.failure}{' '}
      <button
        type="button"
        onClick={() => queue.retry(action.id)}
        className="ml-1 min-h-11 underline"
        data-queue-retry={action.taskId}
      >
        Try again
      </button>
      <button
        type="button"
        onClick={() => queue.dismiss(action.id)}
        className="ml-3 min-h-11 underline"
      >
        Dismiss
      </button>
    </p>
  );
}

function TaskCard({
  task,
  config,
  actions,
  open,
  onOpen,
  onClose,
  onEnqueue,
}: {
  task: TodayTaskCard;
  config: TaskConfig;
  actions: readonly QueuedAction[];
  open: 'done' | 'move' | null;
  onOpen(sheet: 'done' | 'move'): void;
  onClose(): void;
  onEnqueue(action: {
    id: string;
    kind: 'complete' | 'reschedule';
    taskId: string;
    label: string;
    payload: Record<string, string>;
  }): void;
}) {
  const sending = actions.some((action) => action.failure === null);
  const lead = task.lead;
  // `telHref`/`whatsappHref` answer `null` for anything that is not E.164, so a half-typed number
  // gets no link rather than a link that opens the dialler on nothing.
  const call = telHref(lead?.phoneE164);
  const chat = whatsappHref(lead?.whatsappE164 ?? lead?.phoneE164);

  return (
    <li
      className={`rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 ${
        sending ? 'opacity-60' : ''
      }`}
      data-task={task.id}
      aria-busy={sending}
    >
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium" data-task-title={task.id}>
          {task.title}
        </span>
        <span
          className={`text-xs ${task.minutesUntilDue < 0 ? 'font-medium text-rose-700' : 'text-[var(--color-text-muted)]'}`}
          data-task-when={task.id}
        >
          {describeDelta(task.minutesUntilDue)}
        </span>
        {(task.priority === 'high' || task.priority === 'urgent') && (
          <span className="text-xs font-medium text-amber-700">
            {task.priority === 'urgent' ? 'Urgent' : 'High'}
          </span>
        )}
      </p>

      {lead && (
        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]" data-task-lead={task.id}>
          <Link href={`/leads/${lead.id}`} className="underline">
            {lead.fullName}
          </Link>
          {lead.phoneE164 && <> · {lead.phoneE164}</>}
          {lead.valueMinor !== null && lead.currency && (
            <> · {formatMoney(lead.valueMinor, lead.currency)}</>
          )}
          {lead.scoreBand && (
            <>
              {' '}
              · <span className="numeric">{lead.score}</span> ({lead.scoreBand.toLowerCase()})
            </>
          )}
          {lead.source && <> · {lead.source.name}</>}
        </p>
      )}
      {!lead && task.customer && (
        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
          <Link href={`/customers/${task.customer.id}`} className="underline">
            {task.customer.fullName}
          </Link>
        </p>
      )}

      {sending && (
        <p className="mt-1 text-xs text-[var(--color-text-muted)]" data-task-sending={task.id}>
          Sending…
        </p>
      )}

      {/*
        Four targets, each at least 44 px tall and each able to take the full width of a 375 px
        screen when it has to wrap. `tel:` and `wa.me` hand off to the device — this is not the
        click-to-call abstraction that logs the call, which arrives with the call channel.
      */}
      <div className="mt-2 flex flex-wrap gap-2">
        {call && (
          <CardAction href={call} testId={`call-${task.id}`}>
            Call
          </CardAction>
        )}
        {chat && lead?.consentWhatsapp === true && (
          <CardAction href={chat} testId={`whatsapp-${task.id}`}>
            WhatsApp
          </CardAction>
        )}
        <CardButton onClick={() => onOpen('done')} testId={`done-${task.id}`} primary>
          Done
        </CardButton>
        <CardButton onClick={() => onOpen('move')} testId={`move-${task.id}`}>
          Move
        </CardButton>
      </div>

      {open === 'done' && (
        <DoneSheet task={task} config={config} onEnqueue={onEnqueue} onClose={onClose} />
      )}
      {open === 'move' && (
        <MoveSheet task={task} config={config} onEnqueue={onEnqueue} onClose={onClose} />
      )}
    </li>
  );
}

function CardAction({
  href,
  children,
  testId,
}: {
  href: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 text-sm sm:flex-none"
      data-card-action={testId}
    >
      {children}
    </a>
  );
}

function CardButton({
  onClick,
  children,
  testId,
  primary,
}: {
  onClick(): void;
  children: React.ReactNode;
  testId: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-card)] px-3 text-sm sm:flex-none ${
        primary
          ? 'bg-[var(--color-primary)] font-medium text-[var(--color-primary-contrast)]'
          : 'border border-[var(--color-border)]'
      }`}
      data-card-action={testId}
    >
      {children}
    </button>
  );
}

/** The browser's own instant for a date and a time somebody typed. */
function instantFrom(date: string, time: string): string | null {
  const when = new Date(`${date}T${time || '10:00'}:00`);
  return Number.isNaN(when.getTime()) ? null : when.toISOString();
}

function newActionId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Finishing a follow-up: an outcome, optionally a note, and the next one pre-offered.
 *
 * The outcome is required by `FR-TSK-6` and by the database, and "create the next follow-up" is
 * **pre-ticked**: the single most valuable habit this product can encourage is that a lead never
 * leaves a conversation without the next step on it, and a tick somebody has to find is a habit
 * that does not form.
 */
function DoneSheet({
  task,
  config,
  onEnqueue,
  onClose,
}: {
  task: TodayTaskCard;
  config: TaskConfig;
  onEnqueue: Parameters<typeof TaskCard>[0]['onEnqueue'];
  onClose(): void;
}) {
  const [outcomeId, setOutcomeId] = useState('');
  const [note, setNote] = useState('');
  const [scheduleNext, setScheduleNext] = useState(true);
  const due = defaultDue();
  const [date, setDate] = useState(due.date);
  const [time, setTime] = useState(due.time);
  const [error, setError] = useState<string | null>(null);

  const outcome = config.outcomes.find((entry) => entry.id === outcomeId) ?? null;

  function submit(): void {
    if (!outcomeId) {
      setError('Pick what happened — the report is only as good as this field.');
      return;
    }
    if (outcome?.requiresNote && note.trim() === '') {
      setError(`“${outcome.name}” needs a note saying what was said.`);
      return;
    }
    const nextDueAt = scheduleNext ? instantFrom(date, time) : null;
    if (scheduleNext && !nextDueAt) {
      setError('Pick a date for the next follow-up.');
      return;
    }
    onEnqueue({
      id: newActionId(),
      kind: 'complete',
      taskId: task.id,
      label: `Done — ${outcome?.name ?? 'outcome'}`,
      payload: {
        taskId: task.id,
        outcomeId,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(nextDueAt ? { nextDueAt, nextTitle: `Follow up — ${task.title}` } : {}),
      },
    });
    onClose();
  }

  return (
    <Sheet title={`Finish “${task.title}”`} error={error}>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">What happened?</span>
        <select
          value={outcomeId}
          onChange={(event) => setOutcomeId(event.target.value)}
          className="min-h-11 w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          data-done-outcome={task.id}
        >
          <option value="">Choose…</option>
          {config.outcomes.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-3 block text-sm">
        <span className="mb-1 block font-medium">
          Note {outcome?.requiresNote ? '(required)' : '(optional)'}
        </span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          className="w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          data-done-note={task.id}
        />
      </label>

      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={scheduleNext}
          onChange={(event) => setScheduleNext(event.target.checked)}
          data-done-next={task.id}
        />
        <span>Plan the next follow-up</span>
      </label>
      {scheduleNext && (
        <div className="mt-2 flex gap-2">
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="min-h-11 flex-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
            data-done-date={task.id}
          />
          <input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="min-h-11 flex-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
            data-done-time={task.id}
          />
        </div>
      )}

      <SheetActions onSubmit={submit} onClose={onClose} submitLabel="Save" testId={task.id} />
    </Sheet>
  );
}

/** Moving a follow-up: a date, a time and a reason, all three required (`FR-TSK-5`). */
function MoveSheet({
  task,
  config,
  onEnqueue,
  onClose,
}: {
  task: TodayTaskCard;
  config: TaskConfig;
  onEnqueue: Parameters<typeof TaskCard>[0]['onEnqueue'];
  onClose(): void;
}) {
  const due = defaultDue();
  const [date, setDate] = useState(due.date);
  const [time, setTime] = useState(due.time);
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reason = config.rescheduleReasons.find((entry) => entry.id === reasonId) ?? null;

  function submit(): void {
    const dueAt = instantFrom(date, time);
    if (!dueAt) {
      setError('Pick a date and a time.');
      return;
    }
    if (!reasonId) {
      setError('Say why it is moving — chronic rescheduling is a coaching signal.');
      return;
    }
    if (reason?.requiresNote && note.trim() === '') {
      setError(`“${reason.name}” needs a note.`);
      return;
    }
    onEnqueue({
      id: newActionId(),
      kind: 'reschedule',
      taskId: task.id,
      label: `Moved “${task.title}”`,
      payload: {
        taskId: task.id,
        dueAt,
        reasonId,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    });
    onClose();
  }

  return (
    <Sheet title={`Move “${task.title}”`} error={error}>
      <div className="flex gap-2">
        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="min-h-11 flex-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          data-move-date={task.id}
        />
        <input
          type="time"
          value={time}
          onChange={(event) => setTime(event.target.value)}
          className="min-h-11 flex-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          data-move-time={task.id}
        />
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1 block font-medium">Why is it moving?</span>
        <select
          value={reasonId}
          onChange={(event) => setReasonId(event.target.value)}
          className="min-h-11 w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          data-move-reason={task.id}
        >
          <option value="">Choose…</option>
          {config.rescheduleReasons.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      {reason?.requiresNote && (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block font-medium">Note (required)</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            className="w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
            data-move-note={task.id}
          />
        </label>
      )}
      <SheetActions onSubmit={submit} onClose={onClose} submitLabel="Move it" testId={task.id} />
    </Sheet>
  );
}

function Sheet({
  title,
  error,
  children,
}: {
  title: string;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {error && (
        <p className="mb-2 text-sm text-rose-700" role="alert" data-sheet-error>
          {error}
        </p>
      )}
      {children}
    </div>
  );
}

function SheetActions({
  onSubmit,
  onClose,
  submitLabel,
  testId,
}: {
  onSubmit(): void;
  onClose(): void;
  submitLabel: string;
  testId: string;
}) {
  return (
    <div className="mt-3 flex gap-2">
      <button
        type="button"
        onClick={onSubmit}
        className="min-h-11 flex-1 rounded-[var(--radius-card)] bg-[var(--color-primary)] px-3 text-sm font-medium text-[var(--color-primary-contrast)]"
        data-sheet-submit={testId}
      >
        {submitLabel}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="min-h-11 rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 text-sm"
      >
        Cancel
      </button>
    </div>
  );
}
