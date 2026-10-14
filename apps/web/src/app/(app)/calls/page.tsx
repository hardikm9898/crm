import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { formatDateTime, formatPhone, relativeTime } from '@/lib/lead-format';
import { describeCallDuration, loadCallConfig, loadCalls, type CallRecord } from '@/lib/calls';
import { CallStatusChip, RecordOutcomeForm } from './_components/call-forms';

/**
 * The call log (`FR-CALL-1`).
 *
 * **The first section is the work, not the history.** A call that was dialled and never recorded is
 * the one row on this screen somebody can still do something about, so it goes at the top with the
 * outcome form already open — and everything below it is the record. A log that led with the
 * history would be a report; this is meant to be a screen somebody finishes.
 *
 * All the state is in the URL, so "my calls this week with no outcome" is a link somebody can send.
 * The figures are the whole filter's, aggregated by the API: a page that summed the twenty-five rows
 * it loaded would tell a manager their team spent a fraction of the time on the phone that it did.
 */
export const dynamic = 'force-dynamic';

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCurrentUser();
  const params = await searchParams;
  const mine = params['mine'] !== 'false';
  const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : undefined;
  const token = await readAccessToken();

  const query = new URLSearchParams({ limit: '25' });
  if (mine) query.set('mine', 'true');
  if (cursor) query.set('cursor', cursor);

  let page: Awaited<ReturnType<typeof loadCalls>>;
  // Its own request rather than a filter over the page: the calls awaiting an outcome are the point
  // of the screen, and the ones on page three are exactly the ones somebody has forgotten.
  //
  // **Not swallowed**, deliberately. A catch that produced an empty list here would render "No
  // outcome yet: 0" — which is the one number on this screen somebody acts on, and a loader whose
  // failure is indistinguishable from an empty result is the trap the product catalogue paid for.
  let open: Awaited<ReturnType<typeof loadCalls>>;
  try {
    [page, open] = await Promise.all([
      loadCalls(`?${query.toString()}`, token),
      loadCalls(`?open=true&limit=10${mine ? '&mine=true' : ''}`, token),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Calls" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  // The outcome list *is* swallowed: it only fills a dropdown, and a screen that will not open
  // because a vocabulary request failed is worse than one whose form says it has nothing to offer.
  const config = await loadCallConfig(token);
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Calls"
        description="What was said on the phone, and which calls still owe an answer."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <Link
          href="/calls"
          aria-current={mine ? 'page' : undefined}
          className={mine ? 'font-medium' : 'text-[var(--color-text-muted)] underline'}
        >
          Mine
        </Link>
        <Link
          href="/calls?mine=false"
          aria-current={mine ? undefined : 'page'}
          className={mine ? 'text-[var(--color-text-muted)] underline' : 'font-medium'}
        >
          Everyone I can see
        </Link>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Calls" value={String(page.total)} hint="Over the whole filter." />
        <StatCard label="Connected" value={String(page.connected)} hint="Somebody answered." />
        <StatCard
          label="Time on the phone"
          value={describeCallDuration(page.talkTimeSeconds)}
          hint="Added up across every logged call in this filter."
        />
        <StatCard
          label="No outcome yet"
          value={String(open.total)}
          hint="Dialled from the product and never recorded."
        />
      </div>

      {open.items.length > 0 && (
        <div className="mb-5">
          <Card
            title="These calls need an outcome"
            description="You dialled from the product; nobody has said what happened. Until somebody does, the lead's history shows an attempt and nothing else."
          >
            <div className="flex flex-col divide-y divide-[var(--color-border)]/60">
              {open.items.map((call) => (
                <div key={call.id} className="flex flex-col gap-3 py-3" data-open-call={call.id}>
                  <p className="text-sm">
                    <Subject call={call} />{' '}
                    <span className="text-[var(--color-text-muted)]">
                      · dialled {relativeTime(call.startedAt, now)}
                    </span>
                  </p>
                  <RecordOutcomeForm call={call} outcomes={config.outcomes} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      <Card title="The log" description="Newest first.">
        {page.items.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No calls logged yet. Open a lead and use the call panel — logging one by hand works
            before any telephony provider is connected, which is the point.
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left">
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="px-2 py-2 font-medium">What happened</th>
                  <th className="px-2 py-2 text-right font-medium">Length</th>
                  <th className="px-2 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((call) => (
                  <tr
                    key={call.id}
                    className="border-b border-[var(--color-border)]/60"
                    data-call={call.id}
                  >
                    <td className="py-2 pr-3">
                      <Subject call={call} />
                    </td>
                    <td className="px-2 py-2">
                      <CallStatusChip call={call} />
                      {call.notes && (
                        <span className="ml-2 text-[var(--color-text-muted)]">{call.notes}</span>
                      )}
                    </td>
                    <td className="numeric px-2 py-2 text-right">
                      {call.durationSeconds === null ? '—' : call.duration}
                    </td>
                    <td className="px-2 py-2 text-[var(--color-text-muted)]">
                      {formatDateTime(call.startedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {page.nextCursor && (
          <div className="mt-3">
            <Link
              href={`/calls?${mine ? 'mine=true&' : 'mine=false&'}cursor=${page.nextCursor}`}
              className="text-sm text-[var(--color-primary)]"
            >
              Older calls →
            </Link>
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * Who the call was with.
 *
 * The number, when there is no lead: `calls.lead_id` is nullable because a call from somebody
 * nobody recognises is exactly the call most worth keeping, and a row reading "—" would hide it.
 */
function Subject({ call }: { call: CallRecord }) {
  if (call.lead) {
    return (
      <Link href={`/leads/${call.lead.id}`} className="underline" data-call-lead={call.id}>
        {call.lead.fullName}
      </Link>
    );
  }
  const number = call.direction === 'inbound' ? call.fromE164 : call.toE164;
  return (
    <span data-call-number={call.id}>
      {formatPhone(number)}{' '}
      <span className="text-xs text-[var(--color-text-muted)]">· nobody has said who this was</span>
    </span>
  );
}
