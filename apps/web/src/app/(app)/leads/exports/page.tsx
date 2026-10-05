import Link from 'next/link';
import { describeError, request } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import { RunProgress } from '../import/_components/run-progress';

/**
 * Exports (`FR-IO-3`).
 *
 * A list of files rather than a download button, because an export of a hundred thousand leads is
 * a job: it is generated in the background, it has a size, and it expires. Showing the expiry next
 * to the link is the point — a person who finds a stale link knows why it stopped working instead
 * of thinking the product is broken.
 */
export const dynamic = 'force-dynamic';

interface ExportJob {
  id: string;
  status: string;
  entityType: string;
  columns: string[];
  rowCount: number;
  includesPii: boolean;
  error: string | null;
  expiresAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  downloadable: boolean;
}

export default async function ExportsPage() {
  await requireCurrentUser();
  const token = await readAccessToken();

  let jobs: ExportJob[] = [];
  let error: string | null = null;
  try {
    const response = await request<ExportJob[]>('/exports?limit=25', { token });
    jobs = response.data;
  } catch (caught) {
    error = describeError(caught);
  }

  const working = jobs.some((job) => job.status === 'queued' || job.status === 'running');

  return (
    <>
      <RunProgress active={working} />
      <PageHeader
        title="Exports"
        description="Files generated from your lead list. Each one expires, so a link that has been shared cannot be used forever."
        action={
          <Link href="/leads" className="text-sm underline">
            Back to leads
          </Link>
        }
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {jobs.length === 0 ? (
          <EmptyState
            title="No exports yet"
            description="Filter the lead list to what you need, then press Export."
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
                  <th className="py-2 pr-4 font-medium">Requested</th>
                  <th className="py-2 pr-4 font-medium">Rows</th>
                  <th className="py-2 pr-4 font-medium">Columns</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">File</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-[var(--color-border)]/60 align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDate(job.createdAt)}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {job.status === 'completed' ? job.rowCount.toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      {job.columns.length}
                      {job.includesPii && (
                        <span className="ml-2">
                          <Badge tone="warning">Personal data</Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone={toneFor(job.status)}>{labelFor(job)}</Badge>
                      {job.error && (
                        <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                          {job.error}
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      {job.downloadable ? (
                        <>
                          <a
                            href={`/leads/exports/${job.id}/download`}
                            className="underline"
                            data-testid="export-download"
                          >
                            Download CSV
                          </a>
                          {job.expiresAt && (
                            <span className="block text-xs text-[var(--color-text-muted)]">
                              until {formatDate(job.expiresAt)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-[var(--color-text-muted)]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function labelFor(job: ExportJob): string {
  if (job.status === 'completed' && !job.downloadable) return 'Expired';
  switch (job.status) {
    case 'queued':
      return 'Waiting';
    case 'running':
      return 'Generating';
    case 'completed':
      return 'Ready';
    case 'failed':
      return 'Failed';
    default:
      return job.status;
  }
}

function toneFor(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running' || status === 'queued') return 'warning';
  return 'neutral';
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
