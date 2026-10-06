import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken } from '@/lib/session';
import { Card, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { formatDate, formatMoney } from '@/lib/lead-format';
import {
  QUOTATION_STATUS_CLASSES,
  QUOTATION_STATUS_LABELS,
  loadQuotations,
  type QuotationSummary,
} from '@/lib/quotations';

/**
 * Every quotation, newest first.
 *
 * **The current version of each number**, unless the history is asked for: six versions of one
 * quotation shown as six rows is the first thing anybody complains about, and the question this
 * screen answers is "what is outstanding", not "what did we ever send".
 *
 * All of the state is in the URL (`docs/frontend-architecture.md` §3), so a filtered list is a
 * link somebody can send to a colleague.
 */
export const dynamic = 'force-dynamic';

const STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;

export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = typeof params['status'] === 'string' ? params['status'] : undefined;
  const versions = params['versions'] === 'all' ? 'all' : 'current';
  const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : undefined;
  const token = await readAccessToken();

  const query = new URLSearchParams({ limit: '25', versions });
  if (status && (STATUSES as readonly string[]).includes(status)) query.set('status', status);
  if (cursor) query.set('cursor', cursor);

  let page: Awaited<ReturnType<typeof loadQuotations>>;
  try {
    page = await loadQuotations(`?${query.toString()}`, token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Quotations" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const currency = page.items[0]?.currency ?? 'INR';
  const outstanding = page.items.filter((row) => row.status === 'sent');

  return (
    <>
      <PageHeader
        title="Quotations"
        description="What has been offered, at what price, and what came back."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="Shown" value={String(page.total ?? page.items.length)} />
        <StatCard
          label="Value of this filter"
          value={formatMoney(page.totalMinor, currency)}
          hint="The whole filter, not this page"
        />
        <StatCard label="Awaiting an answer" value={String(outstanding.length)} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <FilterLink label="All" href={linkFor({ versions })} active={!status} />
        {STATUSES.map((candidate) => (
          <FilterLink
            key={candidate}
            label={QUOTATION_STATUS_LABELS[candidate]}
            href={linkFor({ status: candidate, versions })}
            active={status === candidate}
          />
        ))}
        <span className="ml-auto">
          <Link
            href={linkFor({
              ...(status ? { status } : {}),
              versions: versions === 'all' ? 'current' : 'all',
            })}
            className="underline"
          >
            {versions === 'all' ? 'Current versions only' : 'Show every version'}
          </Link>
        </span>
      </div>

      <Card>
        {page.items.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No quotations yet. Open a deal and raise one — it takes the deal’s lines with it.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left">
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">For</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Valid until</th>
                  <th className="py-2 pr-4 font-medium">Raised</th>
                  <th className="py-2 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {page.nextCursor && (
        <p className="mt-4 text-sm">
          <Link
            href={linkFor({
              ...(status ? { status } : {}),
              versions,
              cursor: page.nextCursor,
            })}
            className="underline"
          >
            Next page
          </Link>
        </p>
      )}
    </>
  );
}

function Row({ row }: { row: QuotationSummary }) {
  const party = row.customer ?? row.lead;
  return (
    <tr className="border-b border-[var(--color-border)]/60">
      <td className="py-2 pr-4">
        <Link href={`/quotations/${row.id}`} className="font-medium underline">
          {row.label}
        </Link>
        {row.title && (
          <span className="block text-xs text-[var(--color-text-muted)]">{row.title}</span>
        )}
      </td>
      <td className="py-2 pr-4">
        {row.deal ? (
          <Link href={`/deals/${row.deal.id}`} className="underline">
            {row.deal.name}
          </Link>
        ) : (
          (party?.fullName ?? '—')
        )}
      </td>
      <td className="py-2 pr-4">
        <span
          className={`inline-block rounded px-2 py-0.5 text-xs ${QUOTATION_STATUS_CLASSES[row.status]}`}
        >
          {QUOTATION_STATUS_LABELS[row.status]}
        </span>
        {!row.isCurrent && (
          <span className="ml-2 text-xs text-[var(--color-text-muted)]">superseded</span>
        )}
      </td>
      <td className="py-2 pr-4">{row.validUntil ? formatDate(row.validUntil) : '—'}</td>
      <td className="py-2 pr-4">{formatDate(row.createdAt)}</td>
      <td className="numeric py-2">{formatMoney(row.totalMinor, row.currency)}</td>
    </tr>
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

function linkFor(params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  // `versions=current` is the default, so leaving it out keeps the canonical URL short.
  if (query.get('versions') === 'current') query.delete('versions');
  const text = query.toString();
  return text === '' ? '/quotations' : `/quotations?${text}`;
}
