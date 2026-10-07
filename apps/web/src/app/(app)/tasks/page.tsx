import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { formatDateTime } from '@/lib/lead-format';
import {
  BUCKET_CLASSES,
  BUCKET_HINTS,
  BUCKET_LABELS,
  PRIORITY_CLASSES,
  PRIORITY_LABELS,
  QUEUE_BUCKETS,
  isQueueBucket,
  loadTask,
  loadTaskConfig,
  loadTaskCounts,
  loadTasks,
  type TaskSummary,
} from '@/lib/tasks';
import {
  CancelTaskForm,
  CompleteTaskForm,
  RescheduleTaskForm,
  ScheduleTaskForm,
} from './_components/task-forms';

/**
 * The follow-up queue (`FR-TSK-7`).
 *
 * **A queue, not a list.** The sections are in the order somebody works them — overdue first, then
 * the next half hour, then the rest of today — and the counts come from the API's own aggregates
 * over the whole filter rather than from the loaded page, so a screen showing twenty rows cannot
 * claim there are twenty things to do when there are ninety.
 *
 * All the state is in the URL, so "my overdue follow-ups" is a link somebody can send to their
 * manager. A `?taskId=` opens one row's actions, which is what the reminder notification links to.
 *
 * `/today` — the single-request executive screen with the SLA clock on it — is the next step. This
 * screen is the queue it will be built from.
 */
export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const bucket = typeof params['bucket'] === 'string' ? params['bucket'] : undefined;
  const openTaskId = typeof params['taskId'] === 'string' ? params['taskId'] : undefined;
  // A follow-up is always about somebody (`tasks_has_subject`), so this screen can only offer the
  // form once a subject is named — which is what the link from a lead does.
  const forLeadId = typeof params['leadId'] === 'string' ? params['leadId'] : undefined;
  const everyone = params['everyone'] === 'true';
  const token = await readAccessToken();

  const query = new URLSearchParams({ limit: '50', direction: 'asc' });
  if (bucket && isQueueBucket(bucket)) query.set('bucket', bucket);
  else query.set('open', 'true');
  if (!everyone) query.set('mine', 'true');

  let page: Awaited<ReturnType<typeof loadTasks>>;
  let counts: Awaited<ReturnType<typeof loadTaskCounts>>;
  try {
    [page, counts] = await Promise.all([
      loadTasks(`?${query.toString()}`, token),
      loadTaskCounts(token, everyone ? '?mine=false' : '?mine=true'),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Follow-ups" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  // The form's dropdowns. Swallowing is right here: the queue is worth reading even if the
  // vocabulary request failed, and the form says so itself when it has nothing to offer.
  // Loaded by id, not found in the page: `?taskId=` is a deep link from a reminder notification
  // and from the lead panel, and a panel that only opens when the current filter happens to
  // include the row is one that fails silently for a colleague's follow-up.
  const [config, open] = await Promise.all([
    loadTaskConfig(token),
    openTaskId ? loadTask(openTaskId, token) : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader
        title="Follow-ups"
        description="What you owe, soonest first. Overdue at the top, because that is where the day starts."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUEUE_BUCKETS.map((name) => (
          <StatCard
            key={name}
            label={BUCKET_LABELS[name]}
            value={String(counts.counts[name] ?? 0)}
            hint={BUCKET_HINTS[name]}
          />
        ))}
      </div>

      {counts.noNextAction > 0 && (
        <div className="mb-5">
          <Card>
            <p className="text-sm">
              <strong>
                {counts.noNextAction === 1
                  ? '1 open lead has nothing planned'
                  : `${counts.noNextAction} open leads have nothing planned`}
              </strong>{' '}
              — nobody owes them anything, so nothing will happen to them.{' '}
              <Link href="/leads?noNextAction=true" className="underline">
                See them
              </Link>
              .
            </p>
          </Card>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <FilterLink label="Everything open" href={href({ everyone })} active={!bucket} />
        {QUEUE_BUCKETS.map((name) => (
          <FilterLink
            key={name}
            label={BUCKET_LABELS[name]}
            href={href({ everyone, bucket: name })}
            active={bucket === name}
          />
        ))}
        <FilterLink
          label="Done"
          href={href({ everyone, bucket: 'completed' })}
          active={bucket === 'completed'}
        />
        <span className="mx-1 text-[var(--color-text-muted)]">·</span>
        <FilterLink label="Mine" href={href({ everyone: false, bucket })} active={!everyone} />
        <FilterLink label="Everyone’s" href={href({ everyone: true, bucket })} active={everyone} />
      </div>

      <Card
        title="Schedule a follow-up"
        description="A follow-up is always about somebody, so it starts from the lead, the customer or the deal it concerns."
      >
        {forLeadId ? (
          <ScheduleTaskForm config={config} leadId={forLeadId} />
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            <Link href="/leads" className="underline">
              Open a lead
            </Link>{' '}
            and plan the next call from there — or follow the “Schedule a follow-up” link on any
            lead, customer or deal.
          </p>
        )}
      </Card>

      <div className="mt-5">
        {page.items.length === 0 ? (
          <EmptyState
            title="Nothing owed"
            description={
              bucket
                ? 'Nothing in this section. Try another one.'
                : 'No open follow-ups. Open a lead and plan the next call.'
            }
          />
        ) : (
          <Card>
            <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
              {page.items.map((task) => (
                <TaskRow key={task.id} task={task} everyone={everyone} bucket={bucket} />
              ))}
            </ul>
          </Card>
        )}
      </div>

      {open && (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Finish “{open.title}”</h2>
            <CompleteTaskForm task={open} config={config} />
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Move it instead</h2>
            <RescheduleTaskForm task={open} reasons={config.rescheduleReasons} />
            <div className="mt-4 border-t border-[var(--color-border)] pt-4">
              <CancelTaskForm task={open} />
            </div>
          </Card>
        </div>
      )}

      {page.nextCursor && (
        <p className="mt-4 text-sm">
          <Link
            href={`${href({ everyone, bucket })}&cursor=${page.nextCursor}`}
            className="underline"
          >
            Next page
          </Link>
        </p>
      )}
    </>
  );
}

function href(options: { everyone?: boolean; bucket?: string }): string {
  const params = new URLSearchParams();
  if (options.bucket) params.set('bucket', options.bucket);
  if (options.everyone) params.set('everyone', 'true');
  const query = params.toString();
  return `/tasks?${query}`;
}

function TaskRow({
  task,
  everyone,
  bucket,
}: {
  task: TaskSummary;
  everyone: boolean;
  bucket?: string;
}) {
  const party = task.lead ?? task.customer ?? null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3" data-task={task.id}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium" data-task-title={task.id}>
            {task.title}
          </span>
          <span
            className={`inline-block rounded px-2 py-0.5 text-xs ${BUCKET_CLASSES[task.bucket]}`}
          >
            {BUCKET_LABELS[task.bucket]}
          </span>
          {task.taskType && (
            <span className="text-xs text-[var(--color-text-muted)]">{task.taskType.name}</span>
          )}
          {(task.priority === 'high' || task.priority === 'urgent') && (
            <span className={`text-xs font-medium ${PRIORITY_CLASSES[task.priority]}`}>
              {PRIORITY_LABELS[task.priority]}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
          <span data-task-due={task.id}>{formatDateTime(task.dueAt)}</span>
          {party && (
            <>
              {' · '}
              <Link
                href={task.lead ? `/leads/${task.lead.id}` : `/customers/${task.customer!.id}`}
                className="underline"
              >
                {party.fullName}
              </Link>
            </>
          )}
          {task.rescheduleCount > 0 && (
            <span data-task-moved={task.id}>
              {' · '}
              moved {task.rescheduleCount} {task.rescheduleCount === 1 ? 'time' : 'times'}
            </span>
          )}
          {task.outcome && <> · {task.outcome.name}</>}
        </p>
      </div>
      {task.status === 'pending' || task.status === 'in_progress' ? (
        <Link
          href={`${href({ everyone, bucket })}&taskId=${task.id}`}
          className="text-sm underline"
          data-task-open={task.id}
        >
          Log the outcome
        </Link>
      ) : (
        <span className="text-xs text-[var(--color-text-muted)]">
          {task.completedAt ? `Done ${formatDateTime(task.completedAt)}` : 'Called off'}
        </span>
      )}
    </li>
  );
}

function FilterLink({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded px-2 py-1 ${
        active
          ? 'bg-[var(--color-surface-raised)] font-medium'
          : 'text-[var(--color-text-muted)] underline'
      }`}
    >
      {label}
    </Link>
  );
}
