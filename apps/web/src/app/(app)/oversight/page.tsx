import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { relativeTime } from '@/lib/lead-format';
import {
  OVERSIGHT_WINDOWS,
  PERSON_COLUMNS,
  QUEUE_TILES,
  cellValue,
  describeBacklog,
  describeMinutes,
  describeScope,
  isOversightWindow,
  loadOversight,
  type Oversight,
  type OversightPerson,
} from '@/lib/oversight';

/**
 * Oversight — the manager's screen (brief §4, `docs/frontend-architecture.md` §5.4).
 *
 * It answers one question: **who is behind, and on what.** That is six different questions about
 * each person, so this is a table of six answers and deliberately **not** a ranking: a single score
 * hides which dimension somebody is actually behind on, and the moment it exists people optimise
 * it. Nothing on it counts activity either — a leaderboard ranked by calls logged teaches everybody
 * to log calls.
 *
 * **Every number is a link.** A metric you cannot click through to the rows behind it is a dead end
 * (§5.4), so the column definitions in `lib/oversight.ts` carry the number *and* its destination,
 * which is what stops a figure and the list behind it drifting apart.
 *
 * The backlog that belongs to nobody goes first, because a lead with no owner appears in no
 * person's row — it is the number a manager would otherwise never see.
 */
export const dynamic = 'force-dynamic';

export default async function OversightPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCurrentUser();
  const params = await searchParams;
  const requested = Number(typeof params['days'] === 'string' ? params['days'] : '30');
  const days = isOversightWindow(requested) ? requested : 30;
  const token = await readAccessToken();

  let board: Oversight;
  try {
    board = await loadOversight(token, days);
  } catch (error) {
    return (
      <>
        <PageHeader title="Oversight" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Oversight" description={describeBacklog(board.queue)} />

      <p className="mb-4 text-sm text-[var(--color-text-muted)]" data-oversight-scope>
        {describeScope(board.scope.kind, board.scope.people)}{' '}
        {board.scope.truncated && 'Showing the first 50 — export the rest.'}
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {OVERSIGHT_WINDOWS.map((window) => (
          <Link
            key={window}
            href={`/oversight?days=${window}`}
            className={`rounded px-2 py-1 ${
              window === days
                ? 'bg-[var(--color-surface-raised)] font-medium'
                : 'text-[var(--color-text-muted)] underline'
            }`}
            data-window={window}
          >
            Last {window} days
          </Link>
        ))}
      </div>

      {/* The backlog nobody owns. Five tiles, each a link to the list behind its number. */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {QUEUE_TILES.map((tile) => (
          <Link key={tile.key} href={tile.href} className="block">
            <StatCard
              label={tile.label}
              value={String(board.queue[tile.key] ?? 0)}
              hint={tile.hint}
            />
          </Link>
        ))}
      </div>

      {board.promises && (
        <div className="mb-5">
          <Card
            title="Promises"
            description={`What the business promised about getting back to people, over the last ${days} days.`}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Figure
                label="Answered on time"
                value={board.promises.onTimeRate === null ? '—' : `${board.promises.onTimeRate}%`}
                href="/sla"
              />
              <Figure
                label="Median reply"
                value={
                  board.promises.medianResponseMinutes === null
                    ? '—'
                    : describeMinutes(board.promises.medianResponseMinutes)
                }
                href="/sla"
              />
              <Figure label="Missed" value={String(board.promises.breached)} href="/sla" />
              <Figure label="Running out" value={String(board.promises.atRisk)} href="/sla" />
              <Figure
                label="Answered late"
                value={String(board.promises.answeredLate)}
                href="/sla"
              />
            </div>
          </Card>
        </div>
      )}

      <Card
        title="The people"
        description="No rank and no total: a single score would hide which of these somebody is actually behind on, and nothing here counts activity."
      >
        {board.people.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Nobody else to show. Invite your team from{' '}
            <Link href="/settings/members" className="underline">
              People
            </Link>
            .
          </p>
        ) : (
          /* A table that scrolls sideways on a phone rather than reflowing: these columns only
             mean anything next to each other. */
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[56rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left">
                  <th className="py-2 pr-3 font-medium">Person</th>
                  {PERSON_COLUMNS.map((column) => (
                    <th
                      key={String(column.key)}
                      className="px-2 py-2 text-right font-medium"
                      title={column.hint}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.people.map((person) => (
                  <PersonRow key={person.userId} person={person} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-4 text-xs text-[var(--color-text-muted)]">
        As of {relativeTime(board.generatedAt)} · {board.timeZone} · every figure is counted over
        the whole set, not over a page · these cards will read rollup tables when those arrive, and
        until then each number is a live aggregate.
      </p>
    </>
  );
}

function PersonRow({ person }: { person: OversightPerson }) {
  return (
    <tr className="border-b border-[var(--color-border)]/60" data-person={person.userId}>
      <th scope="row" className="py-2 pr-3 text-left font-normal">
        <span className="font-medium" data-person-name={person.userId}>
          {person.name}
        </span>
      </th>
      {PERSON_COLUMNS.map((column) => {
        const value = cellValue(column, person);
        const href = column.href(person);
        const raw = person[column.key];
        // A zero is deliberately quiet and a cost above zero is not: the eye should land on the
        // two numbers that need a conversation, not on the forty that do not.
        const tone =
          column.kind === 'cost' && typeof raw === 'number' && raw > 0
            ? 'font-medium text-rose-700'
            : value === '—'
              ? 'text-[var(--color-text-muted)]'
              : '';
        return (
          <td
            key={String(column.key)}
            className={`numeric px-2 py-2 text-right ${tone}`}
            data-cell={`${person.userId}:${String(column.key)}`}
          >
            {href && value !== '—' ? (
              <Link href={href} className="underline decoration-dotted">
                {value}
              </Link>
            ) : (
              value
            )}
          </td>
        );
      })}
    </tr>
  );
}

function Figure({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link href={href} className="block">
      <StatCard label={label} value={value} />
    </Link>
  );
}
