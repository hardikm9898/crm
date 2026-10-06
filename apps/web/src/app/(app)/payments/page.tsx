import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken } from '@/lib/session';
import { Card, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { formatDate, formatMoney } from '@/lib/lead-format';
import {
  PAYMENT_STATUS_CLASSES,
  PAYMENT_STATUS_LABELS,
  loadPayments,
  type PaymentSummary,
} from '@/lib/payments';

/**
 * Money received, newest first.
 *
 * **Two totals, not one.** The filter's sum answers "what is on this list"; the received sum answers
 * "how much money do we actually have", and a screen that showed only the first would count a
 * bounced cheque as revenue. All the state is in the URL, so a filtered list is a link somebody can
 * send to whoever does the reconciliation.
 */
export const dynamic = 'force-dynamic';

const STATUSES = ['succeeded', 'pending', 'failed', 'refunded'] as const;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = typeof params['status'] === 'string' ? params['status'] : undefined;
  const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : undefined;
  const token = await readAccessToken();

  const query = new URLSearchParams({ limit: '25' });
  if (status && (STATUSES as readonly string[]).includes(status)) query.set('status', status);
  if (cursor) query.set('cursor', cursor);

  let page: Awaited<ReturnType<typeof loadPayments>>;
  try {
    page = await loadPayments(`?${query.toString()}`, token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Payments" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const currency = page.items[0]?.currency ?? 'INR';
  const uncleared = page.items.filter((row) => row.status === 'pending');

  return (
    <>
      <PageHeader
        title="Payments"
        description="What has actually arrived, by what method, against which reference."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Received"
          value={formatMoney(page.receivedMinor, currency)}
          hint="This filter, cleared payments only"
        />
        <StatCard
          label="On this filter"
          value={formatMoney(page.totalMinor, currency)}
          hint="Including anything not yet cleared"
        />
        <StatCard label="Not cleared" value={String(uncleared.length)} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <FilterLink label="All" href="/payments" active={!status} />
        {STATUSES.map((candidate) => (
          <FilterLink
            key={candidate}
            label={PAYMENT_STATUS_LABELS[candidate]}
            href={`/payments?status=${candidate}`}
            active={status === candidate}
          />
        ))}
      </div>

      <Card>
        {page.items.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Nothing recorded yet. Open a deal and record a payment against it.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left">
                  <th className="py-2 pr-4 font-medium">Receipt</th>
                  <th className="py-2 pr-4 font-medium">From</th>
                  <th className="py-2 pr-4 font-medium">Method</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Received</th>
                  <th className="py-2 font-medium">Amount</th>
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
            href={`/payments?${new URLSearchParams({
              ...(status ? { status } : {}),
              cursor: page.nextCursor,
            }).toString()}`}
            className="underline"
          >
            Next page
          </Link>
        </p>
      )}
    </>
  );
}

function Row({ row }: { row: PaymentSummary }) {
  const party = row.customer ?? row.lead;
  return (
    <tr className="border-b border-[var(--color-border)]/60">
      <td className="py-2 pr-4">
        <Link href={`/payments/${row.id}`} className="font-medium underline">
          {row.number}
        </Link>
        {row.reference && (
          <span className="block text-xs text-[var(--color-text-muted)]">{row.reference}</span>
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
      <td className="py-2 pr-4">{row.method?.name ?? '—'}</td>
      <td className="py-2 pr-4">
        <span
          className={`inline-block rounded px-2 py-0.5 text-xs ${PAYMENT_STATUS_CLASSES[row.status]}`}
        >
          {PAYMENT_STATUS_LABELS[row.status]}
        </span>
      </td>
      <td className="py-2 pr-4">{row.paidAt ? formatDate(row.paidAt) : '—'}</td>
      <td className="numeric py-2">{formatMoney(row.amountMinor, row.currency)}</td>
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
