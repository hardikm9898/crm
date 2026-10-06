import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  StatCard,
} from '@/components/ui';
import { formatDate, formatMoney, relativeTime } from '@/lib/lead-format';
import { loadDealBoard, loadDeals, type DealBoard, type DealSummary } from '@/lib/deals';

/**
 * Deals (`FR-DEAL-1`).
 *
 * The **board is the default**, because a sales manager opening this screen is asking "what is in
 * play and what is it worth", and a list answers neither at a glance. `?view=list` is the same data
 * as a table, for the questions a board is bad at — "everything closing this month", "what did we
 * win". Both are URL state, like every other list in this app.
 *
 * Each column reports its count, its value and its **weighted** value. The weighted figure is the
 * honest one: a pipeline report that adds up full deal values tells a business owner they are about
 * to receive money that is still a conversation.
 */
export const dynamic = 'force-dynamic';

interface SearchParams {
  view?: string;
  outcome?: string;
  search?: string;
  cursor?: string;
}

export default async function DealsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const user = await requireCurrentUser();
  const token = await readAccessToken();
  const asList = params.view === 'list';

  return (
    <>
      <PageHeader
        title="Deals"
        description={
          asList
            ? 'Every deal, filtered. The total is for the whole filter, not this page.'
            : 'What is in play, and what it is worth. The weighted figure is what the stages imply.'
        }
        action={
          <div className="flex items-center gap-2">
            <Link href={asList ? '/deals' : '/deals?view=list'} className="text-sm underline">
              {asList ? 'Board' : 'List'}
            </Link>
            {can(user, 'deal:manage') && (
              <Link href="/deals/new">
                <Button>New deal</Button>
              </Link>
            )}
          </div>
        }
      />

      {asList ? <DealList params={params} token={token} /> : <Board token={token} />}
    </>
  );
}

async function Board({ token }: { token: string | null }) {
  let board: DealBoard;
  try {
    board = await loadDealBoard('?limit=8', token);
  } catch (error) {
    return <ErrorNotice>{describeError(error)}</ErrorNotice>;
  }

  const currency = board.columns.flatMap((column) => column.deals)[0]?.currency ?? 'INR';
  const value = board.columns.reduce((sum, column) => sum + column.valueMinor, 0);
  const weighted = board.columns.reduce((sum, column) => sum + column.weightedMinor, 0);
  const count = board.columns.reduce((sum, column) => sum + column.total, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Open deals" value={count.toLocaleString('en-IN')} />
        <StatCard label="Pipeline value" value={formatMoney(value, currency)} />
        <StatCard
          label="Weighted"
          value={formatMoney(weighted, currency)}
          hint="What the stages imply, not the sum of hopes"
        />
      </div>

      <div className="flex gap-4 overflow-x-auto pb-2">
        {board.columns
          // Won and lost columns are an outcome, not a step: the revenue list is where they belong.
          .filter((column) => !column.stage.isWon && !column.stage.isLost)
          .map((column) => (
            <section
              key={column.stage.id}
              className="flex w-72 shrink-0 flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3"
            >
              <header>
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold">{column.stage.name}</h2>
                  <span className="numeric text-xs text-[var(--color-text-muted)]">
                    {column.total}
                  </span>
                </div>
                <p className="numeric mt-0.5 text-xs text-[var(--color-text-muted)]">
                  {formatMoney(column.valueMinor, currency)} ·{' '}
                  {formatMoney(column.weightedMinor, currency)} at {column.stage.probability}%
                </p>
              </header>

              {column.deals.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">Nothing here.</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {column.deals.map((deal) => (
                    <li key={deal.id}>
                      <Link
                        href={`/deals/${deal.id}`}
                        className="block rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 hover:border-[var(--color-primary)]"
                      >
                        <p className="text-sm font-medium">{deal.name}</p>
                        <p className="numeric text-xs text-[var(--color-text-muted)]">
                          {formatMoney(deal.valueMinor, deal.currency)}
                        </p>
                        <p className="mt-1 truncate text-xs text-[var(--color-text-muted)]">
                          {deal.customer?.fullName ?? deal.lead?.fullName ?? 'Nobody'} ·{' '}
                          {deal.owner?.name ?? 'unowned'}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ol>
              )}

              {column.total > column.deals.length && (
                <Link
                  href={`/deals?view=list&stageId=${column.stage.id}`}
                  className="text-xs underline"
                >
                  See all {column.total}
                </Link>
              )}
            </section>
          ))}
      </div>
    </div>
  );
}

async function DealList({ params, token }: { params: SearchParams; token: string | null }) {
  const query = new URLSearchParams({ limit: '25', outcome: params.outcome ?? 'any' });
  if (params.search) query.set('search', params.search);
  if (params.cursor) query.set('cursor', params.cursor);

  let deals: DealSummary[] = [];
  let totalValueMinor = 0;
  let total: number | undefined;
  let nextCursor: string | null = null;
  let error: string | null = null;
  try {
    const page = await loadDeals(`?${query.toString()}`, token);
    deals = page.items;
    totalValueMinor = page.totalValueMinor;
    total = page.total;
    nextCursor = page.nextCursor;
  } catch (caught) {
    error = describeError(caught);
  }

  const currency = deals[0]?.currency ?? 'INR';

  return (
    <>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <Card>
        <form method="get" action="/deals" className="mb-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="view" value="list" />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Search
            </span>
            <input
              type="search"
              name="search"
              defaultValue={params.search ?? ''}
              placeholder="Deal name"
              className="min-w-56 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Outcome
            </span>
            <select
              name="outcome"
              defaultValue={params.outcome ?? 'any'}
              className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
            >
              <option value="any">All</option>
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
          </label>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {total !== undefined && (
            <p className="numeric ml-auto text-sm text-[var(--color-text-muted)]">
              {total} deal{total === 1 ? '' : 's'} · {formatMoney(totalValueMinor, currency)}
            </p>
          )}
        </form>

        {deals.length === 0 ? (
          <EmptyState
            title="No deals yet"
            description="A deal is money being discussed. Create one from a lead you are working, or from a customer who is coming back."
            action={
              <Link href="/leads" className="text-sm underline">
                Go to leads
              </Link>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left">
                  <th className="py-2 pr-4 font-medium">Deal</th>
                  <th className="py-2 pr-4 font-medium">With</th>
                  <th className="py-2 pr-4 font-medium">Stage</th>
                  <th className="py-2 pr-4 font-medium">Value</th>
                  <th className="py-2 pr-4 font-medium">Weighted</th>
                  <th className="py-2 pr-4 font-medium">Closing</th>
                  <th className="py-2 font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((deal) => (
                  <tr key={deal.id} className="border-b border-[var(--color-border)]/60">
                    <td className="py-2 pr-4">
                      <Link href={`/deals/${deal.id}`} className="font-medium underline">
                        {deal.name}
                      </Link>
                      {deal.outcome !== 'open' && (
                        <span className="ml-2">
                          <Badge tone={deal.outcome === 'won' ? 'success' : 'danger'}>
                            {deal.outcome === 'won' ? 'Won' : 'Lost'}
                          </Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {deal.customer ? (
                        <Link href={`/customers/${deal.customer.id}`} className="underline">
                          {deal.customer.fullName}
                        </Link>
                      ) : deal.lead ? (
                        <Link href={`/leads/${deal.lead.id}`} className="underline">
                          {deal.lead.fullName}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 pr-4">{deal.stage.name ?? '—'}</td>
                    <td className="numeric py-2 pr-4">
                      {formatMoney(deal.valueMinor, deal.currency)}
                    </td>
                    <td className="numeric py-2 pr-4 text-[var(--color-text-muted)]">
                      {formatMoney(deal.weightedMinor, deal.currency)}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {deal.expectedCloseDate ? formatDate(deal.expectedCloseDate) : '—'}
                    </td>
                    <td className="py-2 whitespace-nowrap text-[var(--color-text-muted)]">
                      {deal.lastActivityAt ? relativeTime(deal.lastActivityAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor && (
          <div className="mt-4">
            <Link
              href={`/deals?view=list&outcome=${params.outcome ?? 'any'}&cursor=${nextCursor}`}
              className="text-sm underline"
            >
              Load more
            </Link>
          </div>
        )}
      </Card>
    </>
  );
}
