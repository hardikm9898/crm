import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { formatDateTime } from '@/lib/lead-format';
import {
  BOARD_COUNTS,
  HEALTH_CLASSES,
  HEALTH_LABELS,
  TARGET_LABELS,
  describeTargetMinutes,
  loadEscalations,
  loadSlaBoard,
  minutesFromNow,
  type SlaClock,
} from '@/lib/sla';
import { AcknowledgeButton } from './_components/sla-forms';

/**
 * The breach board (`FR-TSK-8`).
 *
 * **Every count is an aggregate over the whole filter**, not a tally of the loaded page — the
 * mistake the pipeline board paid for. And every reading is derived from the clock rather than from
 * the stored state, so a manager refreshing at 10:01 is never told a 10:00 promise is still fine
 * because the five-minute sweep has not fired.
 *
 * "Answered late" is its own column on purpose: a clock somebody eventually got to is a different
 * management problem from one still sitting there, and folding them together could not tell a
 * backlog from a habit.
 */
export const dynamic = 'force-dynamic';

export default async function SlaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const mine = params['mine'] === 'true';
  const token = await readAccessToken();

  let board: Awaited<ReturnType<typeof loadSlaBoard>>;
  try {
    board = await loadSlaBoard(token, mine ? '?mine=true' : '');
  } catch (error) {
    return (
      <>
        <PageHeader title="Response times" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const escalations = await loadEscalations(token, '?unacknowledgedOnly=true&limit=20');
  const now = new Date(board.generatedAt);

  return (
    <>
      <PageHeader
        title="Response times"
        description="What the business promised about getting back to people, and whether it did."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {BOARD_COUNTS.map((entry) => (
          <StatCard
            key={entry.key}
            label={entry.label}
            value={String(board.counts[entry.key] ?? 0)}
            hint={entry.hint}
          />
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <FilterLink label="Everyone’s" href="/sla" active={!mine} />
        <FilterLink label="Mine" href="/sla?mine=true" active={mine} />
      </div>

      {escalations.length > 0 && (
        <div className="mb-5">
          <Card
            title={`${escalations.length} ${escalations.length === 1 ? 'escalation' : 'escalations'} nobody has acknowledged`}
            description="Each was sent once, to the people the policy names. Marking it seen is a statement about you, not a change to the lead."
          >
            <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
              {escalations.map((escalation) => (
                <li
                  key={escalation.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                  data-escalation={escalation.id}
                >
                  <span className="text-sm">
                    <span
                      className={`mr-2 inline-block rounded px-2 py-0.5 text-xs ${
                        escalation.reason === 'breached'
                          ? HEALTH_CLASSES.breached
                          : HEALTH_CLASSES.at_risk
                      }`}
                    >
                      {escalation.reason === 'breached' ? 'Missed' : 'Running out'}
                    </span>
                    {escalation.clock?.lead ? (
                      <Link href={`/leads/${escalation.clock.lead.id}`} className="underline">
                        {escalation.clock.lead.fullName}
                      </Link>
                    ) : (
                      'A lead'
                    )}
                    <span className="text-[var(--color-text-muted)]">
                      {' '}
                      · {escalation.policy?.name ?? 'an SLA'} ·{' '}
                      {formatDateTime(escalation.createdAt)}
                    </span>
                  </span>
                  <AcknowledgeButton escalationId={escalation.id} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {board.items.length === 0 ? (
        <EmptyState
          title="Nothing running"
          description="No lead is currently waiting on a first response. New captures start their clock automatically."
        />
      ) : (
        <Card
          title="Running out soonest"
          description="The clocks still open, in the order they come due."
        >
          <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
            {board.items.map((clock) => (
              <ClockRow key={clock.id} clock={clock} now={now} />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function ClockRow({ clock, now }: { clock: SlaClock; now: Date }) {
  const left = minutesFromNow(clock.dueAt, now);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3" data-clock={clock.id}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          {clock.lead ? (
            <Link href={`/leads/${clock.lead.id}`} className="font-medium underline">
              {clock.lead.fullName}
            </Link>
          ) : (
            <span className="font-medium">A lead</span>
          )}
          <span
            className={`inline-block rounded px-2 py-0.5 text-xs ${HEALTH_CLASSES[clock.health]}`}
            data-clock-health={clock.id}
          >
            {HEALTH_LABELS[clock.health]}
          </span>
          <span className="text-xs text-[var(--color-text-muted)]">
            {TARGET_LABELS[clock.target]}
          </span>
        </p>
        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
          {clock.policy?.name ?? 'An SLA'} — {describeTargetMinutes(clock.targetMinutes)} · due{' '}
          {formatDateTime(clock.dueAt)}
        </p>
      </div>
      <span className="text-sm" data-clock-left={clock.id}>
        {left >= 0 ? `${left} min left` : `${Math.abs(left)} min over`}
      </span>
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
