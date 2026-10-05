import Link from 'next/link';
import { describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Button, Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import { decodeFilter, leadListHref, toApiFilter, type CatalogueField } from '@/lib/lead-filters';
import {
  labelsOf,
  loadMembers,
  loadOptions,
  membersLabels,
  type LeadSummary,
  type Option,
  type SavedView,
  type ScoreBand,
} from '@/lib/leads';
import { FilterBar } from './_components/filter-bar';
import { LeadTable } from './_components/lead-table';

/**
 * The lead list (`FR-LEAD`, `FR-VIEW-2`, `FR-VIEW-3`).
 *
 * A server component driven entirely by the URL. `?view=` runs a saved view, `?f=` an ad-hoc
 * filter, `?sort=`/`?dir=` the order, `?cursor=` the page. Both filter paths go through
 * `POST /leads/search`, which is the same endpoint the API uses for a saved view — two paths would
 * drift, and the one that drifted would be the view a business opens every morning.
 *
 * There is no client data cache. Every list here must be correct at first paint and re-read after a
 * mutation, and a cache would add a loading state, a second source of truth, and a hydration
 * boundary in exchange for nothing until infinite scroll exists.
 */
export const dynamic = 'force-dynamic';

interface SearchParams {
  view?: string;
  f?: string;
  sort?: string;
  dir?: string;
  cursor?: string;
  deleted?: string;
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const user = await requireCurrentUser();
  const token = await readAccessToken();
  const deleted = params.deleted === '1';
  const conditions = decodeFilter(params.f);
  const sort = params.sort ?? null;
  const direction = params.dir ?? null;

  const [views, fields, bands, statuses, sources, tags, members] = await Promise.all([
    loadViews(token),
    loadFields(token),
    loadBands(token),
    loadOptions('/crm/statuses', token),
    loadOptions('/crm/sources', token),
    loadOptions('/crm/tags', token),
    loadMembers(token),
  ]);

  const activeView = params.view ? views.find((view) => view.id === params.view) : undefined;
  // A saved view's own filter is shown as chips too, so "why am I seeing these rows" is answerable
  // without opening the view's definition.
  const viewConditions = activeView ? decodeFilterFromView(activeView) : [];
  const effective = conditions.length > 0 ? conditions : viewConditions;

  let leads: LeadSummary[] = [];
  let nextCursor: string | null = null;
  let total: number | undefined;
  let error: string | null = null;

  try {
    const body: Record<string, unknown> = {
      limit: 25,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(deleted ? { deleted: true } : {}),
      ...(sort ? { sort: { field: sort, direction: direction === 'asc' ? 'asc' : 'desc' } } : {}),
    };
    // A view id is sent as a view id, not as its expanded filter: the API resolves it, checks its
    // visibility, and applies its sort — reimplementing that here is how the two drift.
    if (conditions.length === 0 && activeView) body['viewId'] = activeView.id;
    else body['filter'] = toApiFilter(effective);

    const response = await request<LeadSummary[]>('/leads/search', {
      method: 'POST',
      body,
      token,
    });
    leads = response.data;
    nextCursor = response.pagination?.nextCursor ?? null;
    total = response.pagination?.total;
  } catch (caught) {
    error = describeError(caught);
  }

  const labels = { ...labelsOf(statuses, sources, tags), ...membersLabels(members) };
  const options: Record<string, { value: string; label: string }[]> = {
    statusId: statuses.map(asChoice),
    leadSourceId: sources.map(asChoice),
    tagIds: tags.map(asChoice),
    assignedUserId: members.map((member) => ({ value: member.userId, label: member.name })),
    scoreBand: bands.map((band) => ({ value: band.name, label: band.name })),
    priority: ['low', 'medium', 'high', 'urgent'].map((value) => ({ value, label: value })),
  };
  const now = new Date().toISOString();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={deleted ? 'Deleted leads' : (activeView?.name ?? 'Leads')}
        description={
          deleted
            ? 'Nothing here is destroyed. Restore a lead and it comes back with its history.'
            : total !== undefined
              ? `${total} lead${total === 1 ? '' : 's'}${effective.length > 0 ? ' matching' : ''}`
              : undefined
        }
        action={
          can(user, 'lead:create') && !deleted ? (
            <Link href="/leads/new">
              <Button>New lead</Button>
            </Link>
          ) : undefined
        }
      />

      {!deleted && (
        <nav aria-label="Saved views" className="flex flex-wrap items-center gap-2">
          <Link
            href={leadListHref({})}
            className={`rounded-full border px-3 py-1 text-sm ${
              !activeView
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            All leads
          </Link>
          {views.map((view) => (
            <Link
              key={view.id}
              href={leadListHref({ view: view.id })}
              className={`rounded-full border px-3 py-1 text-sm ${
                activeView?.id === view.id
                  ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }`}
            >
              {view.name}
              {view.isMine && !view.isSystem && (
                <span className="ml-1 text-xs text-[var(--color-text-muted)]">· yours</span>
              )}
            </Link>
          ))}
          <Link
            href={leadListHref({ deleted: true })}
            className="ml-auto text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            Deleted
          </Link>
        </nav>
      )}

      {deleted && (
        <Link href={leadListHref({})} className="text-sm text-[var(--color-primary)]">
          ← Back to leads
        </Link>
      )}

      {!deleted && (
        <FilterBar
          fields={fields}
          conditions={effective}
          labels={labels}
          options={options}
          sort={sort}
          direction={direction}
          view={activeView?.id ?? null}
        />
      )}

      <Card>
        {error ? (
          <ErrorNotice>{error}</ErrorNotice>
        ) : leads.length === 0 ? (
          <EmptyState
            title={
              deleted
                ? 'The recycle bin is empty'
                : effective.length > 0
                  ? 'No leads match this filter'
                  : 'No leads yet'
            }
            description={
              deleted
                ? 'Deleted leads appear here until they are purged.'
                : effective.length > 0
                  ? 'Try removing a chip, or widen one of the conditions.'
                  : 'Capture the first one and the timeline, scoring and assignment start working immediately.'
            }
            action={
              // A filter that matched nothing wants clearing, not a new lead: offering "New lead"
              // here answers a question nobody asked and leaves the filter in place.
              effective.length > 0 && !deleted ? (
                <Link href={leadListHref({})}>
                  <Button variant="secondary">Clear filters</Button>
                </Link>
              ) : !deleted && can(user, 'lead:create') ? (
                <Link href="/leads/new">
                  <Button>New lead</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <SortBar
              sort={sort}
              direction={direction}
              view={activeView?.id ?? null}
              conditions={effective}
            />
            <LeadTable
              leads={leads}
              bands={bands}
              members={members}
              tags={tags.map((entry) => ({ id: entry.id, name: entry.name }))}
              now={now}
              canAssign={can(user, 'lead:assign')}
              canDelete={can(user, 'lead:delete')}
              canUpdate={can(user, 'lead:update')}
              deleted={deleted}
            />
            {nextCursor && (
              <div className="mt-4 flex justify-center">
                <Link
                  href={leadListHref({
                    view: activeView?.id ?? null,
                    conditions: conditions.length > 0 ? conditions : [],
                    sort,
                    direction,
                    cursor: nextCursor,
                    deleted,
                  })}
                >
                  <Button variant="secondary">Next page</Button>
                </Link>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

/** Sorting is a link, not a control: it belongs in the URL like every other part of the query. */
function SortBar({
  sort,
  direction,
  view,
  conditions,
}: {
  sort: string | null;
  direction: string | null;
  view: string | null;
  conditions: ReturnType<typeof decodeFilter>;
}) {
  const columns: { field: string; label: string }[] = [
    { field: 'createdAt', label: 'Newest' },
    { field: 'lastActivityAt', label: 'Last activity' },
    { field: 'score', label: 'Score' },
    { field: 'valueMinor', label: 'Value' },
    { field: 'nextActionAt', label: 'Next action' },
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Sort</span>
      {columns.map((column) => {
        const active = (sort ?? 'createdAt') === column.field;
        const nextDirection = active && direction !== 'asc' ? 'asc' : 'desc';
        return (
          <Link
            key={column.field}
            href={leadListHref({ view, conditions, sort: column.field, direction: nextDirection })}
            className={
              active
                ? 'font-medium text-[var(--color-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }
          >
            {column.label}
            {active && <span aria-hidden> {direction === 'asc' ? '↑' : '↓'}</span>}
            {active && (
              <span className="sr-only">{direction === 'asc' ? ' ascending' : ' descending'}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

function asChoice(option: Option): { value: string; label: string } {
  return { value: option.id, label: option.name };
}

/**
 * A saved view's filter, decoded into the shape the chips use.
 *
 * The API stores the DSL as JSON, so this is a translation rather than a parse — and it tolerates a
 * shape it does not recognise, because a view saved by a later release must not break this page.
 */
function decodeFilterFromView(view: SavedView): ReturnType<typeof decodeFilter> {
  const raw = view.filters?.conditions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => ({
      field: String(entry['field'] ?? ''),
      operator: String(entry['operator'] ?? 'eq'),
      value: entry['value'],
      groupIndex: typeof entry['groupIndex'] === 'number' ? entry['groupIndex'] : 0,
    }))
    .filter((condition) => condition.field !== '');
}

async function loadViews(token: string | null): Promise<SavedView[]> {
  if (!token) return [];
  try {
    const response = await request<SavedView[]>('/views?entityType=lead', { token });
    return response.data;
  } catch {
    return [];
  }
}

async function loadFields(token: string | null): Promise<CatalogueField[]> {
  if (!token) return [];
  try {
    const response = await request<CatalogueField[]>('/views/fields?entityType=lead', { token });
    return response.data;
  } catch {
    return [];
  }
}

async function loadBands(token: string | null): Promise<ScoreBand[]> {
  if (!token) return [];
  try {
    const response = await request<ScoreBand[]>('/scoring/bands', { token });
    return response.data;
  } catch {
    return [];
  }
}
