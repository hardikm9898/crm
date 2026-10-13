import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, StatCard } from '@/components/ui';
import { formatMoney, relativeTime, telHref } from '@/lib/lead-format';
import { loadTaskConfig } from '@/lib/tasks';
import {
  HEALTH_CLASSES,
  HEALTH_LABELS,
  TODAY_TILES,
  describeDay,
  describeMinutes,
  greeting,
  loadToday,
  type Today,
} from '@/lib/today';
import { TodayQueue, type QueueSection } from './_components/queue';

/**
 * Today — the executive workspace (`FR-TSK-7`), and the screen this product is judged on.
 *
 * **Mobile-first, and that is not a slogan.** It is read standing outside a site visit on a
 * mid-range Android: the tiles are two columns at 375 px, every action is at least 44 px tall and
 * takes the full width when it wraps, nothing scrolls sideways, and the whole screen arrives in
 * **one request** so a stalled connection cannot render three of five sections and leave somebody
 * believing the empty ones.
 *
 * **A queue, not a list.** Overdue first, never collapsed, and in red; then the next half hour;
 * then the rest of today. The counts beside each heading are the API's aggregates over the whole
 * set, so twenty cards never claim to be the whole backlog. Under them, the two things the queue
 * cannot tell you: the leads nobody has spoken to, and the promises about to be missed.
 *
 * The actions are **queued and retried** in the browser (`lib/action-queue.ts`), which is the one
 * place in this app where a tap is not a round trip — because the person tapping is on a train.
 */
export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  const token = await readAccessToken();
  const [user, config] = await Promise.all([requireCurrentUser(), loadTaskConfig(token)]);

  let screen: Today;
  try {
    screen = await loadToday(token);
  } catch (error) {
    // No swallowing twin for this one loader: a Today screen that renders empty because the
    // request failed is the worst thing this product can do — somebody reads "nothing overdue"
    // and goes home.
    return (
      <>
        <h1 className="mb-1 text-xl font-semibold">Today</h1>
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const firstName = user.user.name.split(' ')[0] ?? '';
  const sections: QueueSection[] = [
    {
      key: 'overdue',
      heading: 'Overdue',
      hint: 'Nothing is past its time.',
      count: screen.sections.overdue.count,
      items: screen.sections.overdue.items,
      truncated: screen.sections.overdue.truncated,
      href: '/tasks?bucket=overdue',
    },
    {
      key: 'dueNow',
      heading: 'Next up',
      hint: 'Nothing in the next half hour.',
      count: screen.sections.dueNow.count,
      items: screen.sections.dueNow.items,
      truncated: screen.sections.dueNow.truncated,
      href: '/tasks?bucket=due_now',
    },
    {
      key: 'laterToday',
      heading: 'Later today',
      hint: 'Nothing else today.',
      count: screen.sections.laterToday.count,
      items: screen.sections.laterToday.items,
      truncated: screen.sections.laterToday.truncated,
      href: '/tasks?bucket=due_today',
    },
  ];

  return (
    <>
      <header className="mb-4">
        <h1 className="text-xl font-semibold">
          {greeting(new Date())}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]" data-today-summary>
          {describeDay(screen.counts)}
        </p>
      </header>

      {/* Two columns at 375 px, four from `sm`. Each tile is a link to the full list behind it. */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {TODAY_TILES.map((tile) => (
          <Link key={tile.key} href={tile.href} className="block">
            <StatCard
              label={tile.label}
              value={String(screen.counts[tile.key] ?? 0)}
              hint={tile.hint}
            />
          </Link>
        ))}
      </div>

      {screen.counts.noNextAction > 0 && (
        <div className="mb-5">
          <Card>
            <p className="text-sm">
              <strong data-no-next-action={String(screen.counts.noNextAction)}>
                {screen.counts.noNextAction === 1
                  ? '1 open lead has nothing planned'
                  : `${screen.counts.noNextAction} open leads have nothing planned`}
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

      <TodayQueue sections={sections} config={config} />

      <PromisesSection section={screen.sections.promisesRunningOut} />
      <FirstContactSection section={screen.sections.awaitingFirstContact} />

      <p className="mt-6 text-xs text-[var(--color-text-muted)]">
        As of {relativeTime(screen.generatedAt)} · {screen.timeZone} ·{' '}
        <Link href="/tasks" className="underline">
          the whole queue
        </Link>
      </p>
    </>
  );
}

/**
 * The promises about to be missed (`FR-TSK-8`).
 *
 * Above the new-leads section on purpose: a clock running out is a commitment the business has
 * already made, and it outranks a lead nobody has promised anything to yet.
 */
function PromisesSection({ section }: { section: Today['sections']['promisesRunningOut'] }) {
  if (!section.available) {
    return (
      <Unavailable
        heading="Promises running out"
        reason="Your role does not include response times."
      />
    );
  }
  if (section.count === 0) return null;
  return (
    <section className="mb-5" data-section="promisesRunningOut">
      <h2 className="mb-2 text-base font-semibold">
        Promises running out{' '}
        <span className="numeric font-normal" data-section-count="promisesRunningOut">
          ({section.count})
        </span>
      </h2>
      <Card>
        <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
          {section.items.map((clock) => (
            <li key={clock.id} className="py-2" data-clock={clock.id}>
              <p className="flex flex-wrap items-baseline gap-2 text-sm">
                {clock.lead ? (
                  <Link href={`/leads/${clock.lead.id}`} className="font-medium underline">
                    {clock.lead.fullName}
                  </Link>
                ) : (
                  <span className="font-medium">A conversation</span>
                )}
                <span
                  className={`rounded px-2 py-0.5 text-xs ${HEALTH_CLASSES[clock.health] ?? ''}`}
                  data-clock-health={clock.id}
                >
                  {HEALTH_LABELS[clock.health] ?? clock.health}
                </span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {clock.minutesLeft >= 0
                    ? `${describeMinutes(clock.minutesLeft)} left`
                    : `${describeMinutes(clock.minutesLeft)} over`}
                </span>
              </p>
            </li>
          ))}
        </ul>
        {section.truncated && (
          <p className="mt-2 text-sm">
            <Link href="/sla" className="underline">
              The whole board
            </Link>
          </p>
        )}
      </Card>
    </section>
  );
}

/** The leads nobody has spoken to, oldest first — each with the promise still running on it. */
function FirstContactSection({ section }: { section: Today['sections']['awaitingFirstContact'] }) {
  if (!section.available) {
    return <Unavailable heading="New leads" reason="Your role does not include leads." />;
  }
  if (section.count === 0) return null;
  return (
    <section className="mb-5" data-section="awaitingFirstContact">
      <h2 className="mb-2 text-base font-semibold">
        New leads, nobody has called{' '}
        <span className="numeric font-normal" data-section-count="awaitingFirstContact">
          ({section.count})
        </span>
      </h2>
      <ul className="flex flex-col gap-3">
        {section.items.map((lead) => {
          const call = telHref(lead.phoneE164);
          return (
            <li
              key={lead.id}
              className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3"
              data-new-lead={lead.id}
            >
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Link href={`/leads/${lead.id}`} className="font-medium underline">
                  {lead.fullName}
                </Link>
                {lead.promise && (
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${HEALTH_CLASSES[lead.promise.health] ?? ''}`}
                    data-lead-promise={lead.id}
                  >
                    {lead.promise.minutesLeft >= 0
                      ? `${describeMinutes(lead.promise.minutesLeft)} left to answer`
                      : `${describeMinutes(lead.promise.minutesLeft)} over`}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
                {lead.phoneE164 ?? 'No phone'}
                {lead.city && <> · {lead.city}</>}
                {lead.valueMinor !== null && lead.currency && (
                  <> · {formatMoney(lead.valueMinor, lead.currency)}</>
                )}
                {lead.source && <> · {lead.source.name}</>}
                {' · '}
                {relativeTime(lead.createdAt)}
              </p>
              {call && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={call}
                    className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 text-sm sm:flex-none"
                    data-card-action={`call-lead-${lead.id}`}
                  >
                    Call
                  </a>
                  <Link
                    href={`/tasks?leadId=${lead.id}`}
                    className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 text-sm sm:flex-none"
                  >
                    Plan a follow-up
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {section.truncated && (
        <p className="mt-2 text-sm">
          <Link
            href="/leads?f=firstContactedAt:is_null"
            className="underline"
            data-section-all="newLeads"
          >
            See all {section.count}
          </Link>
        </p>
      )}
    </section>
  );
}

/**
 * A section the role withholds, said out loud.
 *
 * An empty section and a forbidden one look identical, and must not: somebody whose role does not
 * include leads should know that is why the list is not there, rather than conclude there is
 * nothing to do.
 */
function Unavailable({ heading, reason }: { heading: string; reason: string }) {
  return (
    <section className="mb-5" data-section-unavailable={heading}>
      <h2 className="mb-2 text-base font-semibold">{heading}</h2>
      <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text-muted)]">
        {reason}
      </p>
    </section>
  );
}
