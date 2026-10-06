import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import { formatDate, relativeTime } from '@/lib/lead-format';
import { loadCustomers, type CustomerSummary } from '@/lib/customers';

/**
 * The customer list.
 *
 * URL state, like every other list in this app: `?search=`, `?converted=`, `?deleted=`, `?cursor=`.
 * So a filtered list is shareable, survives a reload, and the back button undoes a filter.
 */
export const dynamic = 'force-dynamic';

interface SearchParams {
  search?: string;
  converted?: string;
  deleted?: string;
  cursor?: string;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await requireCurrentUser();
  const token = await readAccessToken();
  const deleted = params.deleted === '1';

  const query = new URLSearchParams({ limit: '25' });
  if (params.search) query.set('search', params.search);
  if (params.converted === 'yes') query.set('converted', 'true');
  if (params.converted === 'no') query.set('converted', 'false');
  if (deleted) query.set('deleted', 'true');
  if (params.cursor) query.set('cursor', params.cursor);

  let customers: CustomerSummary[] = [];
  let total: number | undefined;
  let nextCursor: string | null = null;
  let error: string | null = null;
  try {
    const page = await loadCustomers(`?${query.toString()}`, token);
    customers = page.items;
    total = page.total;
    nextCursor = page.nextCursor;
  } catch (caught) {
    error = describeError(caught);
  }

  const href = (next: Partial<SearchParams>): string => {
    const merged = new URLSearchParams();
    const combined = { ...params, ...next };
    for (const [key, value] of Object.entries(combined)) {
      if (value) merged.set(key, String(value));
    }
    // A filter change starts a new page: keeping a cursor from the previous filter would show a
    // page from the middle of a different list.
    if (next.cursor === undefined) merged.delete('cursor');
    const text = merged.toString();
    return text ? `/customers?${text}` : '/customers';
  };

  return (
    <>
      <PageHeader
        title={deleted ? 'Deleted customers' : 'Customers'}
        description={
          deleted
            ? 'Nothing here is destroyed. Restore a customer and their whole history comes back.'
            : total !== undefined
              ? `${total} customer${total === 1 ? '' : 's'}`
              : undefined
        }
        action={
          can(user, 'customer:manage') && !deleted ? (
            <Link href="/customers/new">
              <Button>New customer</Button>
            </Link>
          ) : undefined
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        <form method="get" action="/customers" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Search
            </span>
            <input
              type="search"
              name="search"
              defaultValue={params.search ?? ''}
              placeholder="Name, company, email, last digits of the number"
              className="min-w-64 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Came from a lead
            </span>
            <select
              name="converted"
              defaultValue={params.converted ?? ''}
              className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
            >
              <option value="">Either</option>
              <option value="yes">Converted</option>
              <option value="no">Entered directly</option>
            </select>
          </label>
          {deleted && <input type="hidden" name="deleted" value="1" />}
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          <Link
            href={deleted ? '/customers' : '/customers?deleted=1'}
            className="text-sm underline"
          >
            {deleted ? 'Back to customers' : 'Recycle bin'}
          </Link>
        </form>

        {customers.length === 0 ? (
          <EmptyState
            title={deleted ? 'Nothing in the recycle bin' : 'No customers yet'}
            description={
              deleted
                ? undefined
                : 'A customer appears here when you convert a won lead, or when you add one directly.'
            }
            action={
              deleted ? undefined : (
                <Link href="/leads" className="text-sm underline">
                  Go to leads
                </Link>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left">
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 font-medium">Company</th>
                  <th className="py-2 pr-4 font-medium">Contact</th>
                  <th className="py-2 pr-4 font-medium">Account manager</th>
                  <th className="py-2 pr-4 font-medium">Since</th>
                  <th className="py-2 font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id} className="border-b border-[var(--color-border)]/60">
                    <td className="py-2 pr-4">
                      <Link href={`/customers/${customer.id}`} className="font-medium underline">
                        {customer.fullName}
                      </Link>
                      {!customer.converted && (
                        <span className="ml-2">
                          <Badge>Direct</Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{customer.company ?? '—'}</td>
                    <td className="py-2 pr-4">{customer.phone ?? customer.email ?? '—'}</td>
                    <td className="py-2 pr-4">{customer.owner?.name ?? 'Nobody'}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {formatDate(customer.convertedAt ?? customer.createdAt)}
                    </td>
                    <td className="py-2 whitespace-nowrap text-[var(--color-text-muted)]">
                      {customer.lastActivityAt ? relativeTime(customer.lastActivityAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor && (
          <div className="mt-4">
            <Link href={href({ cursor: nextCursor })} className="text-sm underline">
              Load more
            </Link>
          </div>
        )}
      </Card>
    </>
  );
}
