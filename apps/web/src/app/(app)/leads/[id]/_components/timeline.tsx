import { Badge } from '@/components/ui';
import { actorName, describeEntry, type TimelineEntryLike } from '@/lib/timeline-registry';
import { formatDateTime, relativeTime } from '@/lib/lead-format';

/**
 * The unified timeline (`FR-TL-1`, `FR-TL-2`), grouped by day.
 *
 * Every row is phrased by the renderer registry, which means a type this build has never heard of
 * still reads as a sentence instead of appearing blank. That is the property that lets the API ship
 * new activity types ahead of this app.
 */
export function Timeline({ entries, now }: { entries: TimelineEntryLike[]; now: string }) {
  const at = new Date(now);
  const days = groupByDay(entries);

  return (
    <ol className="flex flex-col gap-5">
      {days.map(([day, dayEntries]) => (
        <li key={day}>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            {day}
          </p>
          <ol className="flex flex-col gap-3 border-l border-[var(--color-border)] pl-4">
            {dayEntries.map((entry) => {
              const rendered = describeEntry(entry);
              return (
                <li key={entry.id} className="relative">
                  <span
                    aria-hidden
                    className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-[var(--color-border)]"
                  />
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge tone={rendered.tone}>{rendered.label}</Badge>
                    <span className="text-sm">{rendered.description}</span>
                    {entry.visibility === 'internal' && (
                      <span className="text-xs text-[var(--color-text-muted)]">· internal</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {actorName(entry)} ·{' '}
                    <time dateTime={entry.occurredAt}>{relativeTime(entry.occurredAt, at)}</time>
                    {!entry.known && (
                      <span title="This app does not have a renderer for this activity type yet">
                        {' '}
                        · new type
                      </span>
                    )}
                  </p>
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/**
 * Day grouping, newest first.
 *
 * Done here rather than in the API because "which day" depends on who is looking: the API returns
 * instants and the browser knows the reader's timezone.
 */
function groupByDay(entries: readonly TimelineEntryLike[]): [string, TimelineEntryLike[]][] {
  const days = new Map<string, TimelineEntryLike[]>();
  for (const entry of entries) {
    const day = formatDateTime(entry.occurredAt).split(',')[0] ?? 'Earlier';
    const group = days.get(day) ?? [];
    group.push(entry);
    days.set(day, group);
  }
  return [...days.entries()];
}
