import Link from 'next/link';
import { describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import type { LeadSummary, PipelineSummary } from '@/lib/leads';
import { Board } from './_components/board';

/**
 * The pipeline board (`FR-PIP-2`, `NFR-PERF-4`).
 *
 * **One request per column, each a page.** A stage with four thousand leads returns ten, and
 * "Load more" grows that column alone — which is the difference between a board that works for the
 * tenant who needs it and one that only works in a demo. The per-column requests go out in
 * parallel, so the board's latency is one round trip rather than one per stage.
 *
 * Column pagination lives in the URL (`?more=<stageId>&loaded=<n>`), like every other piece of list
 * state in this app, so a half-scrolled board is a link.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ pipeline?: string; more?: string; loaded?: string }>;
}) {
  const params = await searchParams;
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let pipelines: PipelineSummary[] = [];
  let error: string | null = null;
  try {
    const response = await request<PipelineSummary[]>('/crm/pipelines', { token });
    pipelines = response.data.filter((pipeline) => pipeline.isActive);
  } catch (caught) {
    error = describeError(caught);
  }

  const pipeline =
    pipelines.find((entry) => entry.id === params.pipeline) ??
    pipelines.find((entry) => entry.isDefault) ??
    pipelines[0];

  if (error) {
    return (
      <Card>
        <ErrorNotice>{error}</ErrorNotice>
      </Card>
    );
  }
  if (!pipeline) {
    return (
      <Card>
        <EmptyState
          title="No pipeline yet"
          description="A pipeline and its stages are created with your workspace. If this is empty, something went wrong provisioning it."
        />
      </Card>
    );
  }

  // Only the column named in `?more=` is grown. Everything else stays at one page, which is what
  // keeps a board with twenty stages from turning into twenty full table scans.
  const grown = params.more;
  const grownTo = Math.min(Number(params.loaded ?? PAGE_SIZE) || PAGE_SIZE, 200);

  const columns = await Promise.all(
    pipeline.stages.map(async (stage) => {
      const limit = stage.id === grown ? grownTo : PAGE_SIZE;
      try {
        const response = await request<LeadSummary[]>('/leads/search', {
          method: 'POST',
          body: {
            limit,
            filter: {
              conditions: [
                { field: 'stageId', operator: 'eq', value: stage.id, groupIndex: 0 },
                { field: 'pipelineId', operator: 'eq', value: pipeline.id, groupIndex: 0 },
              ],
            },
            sort: { field: 'lastActivityAt', direction: 'desc' },
          },
          token,
        });
        return {
          stageId: stage.id,
          leads: response.data,
          total: response.pagination?.total ?? response.data.length,
          limit,
        };
      } catch {
        // One column that failed should not blank the board.
        return { stageId: stage.id, leads: [] as LeadSummary[], total: 0, limit };
      }
    }),
  );

  const leadsByStage: Record<string, LeadSummary[]> = {};
  const counts: Record<string, number> = {};
  const valueByStage: Record<string, number> = {};
  const loadedPerStage: Record<string, number> = {};
  for (const column of columns) {
    leadsByStage[column.stageId] = column.leads;
    counts[column.stageId] = column.total;
    loadedPerStage[column.stageId] = Math.min(column.limit, column.leads.length);
    // The total of what is *loaded*, labelled as such below: summing a page and calling it the
    // stage's value would overstate a small column and understate a large one.
    valueByStage[column.stageId] = column.leads.reduce(
      (total, lead) => total + (lead.valueMinor ?? 0),
      0,
    );
  }

  const boardTotal = Object.values(counts).reduce((total, count) => total + count, 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={pipeline.name}
        description={`${boardTotal} lead${boardTotal === 1 ? '' : 's'} on this board. Column values are for the leads loaded.`}
        action={
          pipelines.length > 1 ? (
            <nav aria-label="Pipelines" className="flex flex-wrap gap-2">
              {pipelines.map((entry) => (
                <Link
                  key={entry.id}
                  href={`/pipeline?pipeline=${entry.id}`}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    entry.id === pipeline.id
                      ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                  }`}
                >
                  {entry.name}
                </Link>
              ))}
            </nav>
          ) : undefined
        }
      />

      <Board
        stages={pipeline.stages}
        leadsByStage={leadsByStage}
        counts={counts}
        valueByStage={valueByStage}
        loadedPerStage={loadedPerStage}
        canMove={can(user, 'lead:update')}
        now={new Date().toISOString()}
      />

      <p className="text-sm text-[var(--color-text-muted)]">
        Drag a card to move it, or use the picker on the card — both go through the same validation,
        so a stage that requires fields refuses either way.
      </p>
    </div>
  );
}
