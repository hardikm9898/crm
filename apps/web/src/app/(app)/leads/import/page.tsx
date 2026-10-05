import Link from 'next/link';
import { describeError, request } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { MappingForm, type ImportableField, type ImportMode } from './_components/mapping-form';
import { CancelButton, CheckButton, StartButton } from './_components/step-buttons';
import { RunProgress } from './_components/run-progress';
import { UploadForm } from './_components/upload-form';

/**
 * The import wizard (`FR-IO-1`).
 *
 * One screen whose step is decided by the **job's own status**, not by client state: no job in the
 * URL means step one, an `uploaded` job means map the columns, a `validated` job means review and
 * start, a `running` job means watch it. That is why `?job=` is in the URL — the wizard is
 * reloadable, linkable to a colleague, and survives the tab being closed halfway through a
 * 12 000-row file.
 */
export const dynamic = 'force-dynamic';

interface ImportTotals {
  rows: number;
  processed: number;
  created: number;
  updated: number;
  attached: number;
  skipped: number;
  failed: number;
}

interface ImportJob {
  id: string;
  status: string;
  mode: string;
  delimiter: string;
  fileName: string | null;
  mapping: Record<string, string>;
  totals: ImportTotals;
  error: string | null;
  hasErrorFile: boolean;
}

interface ImportPreview {
  id: string;
  status: string;
  mode: string;
  header: string[];
  totalRows: number;
  mapping: Record<string, string>;
  unmatched: string[];
  ambiguous: { field: string; headers: string[] }[];
  fields: ImportableField[];
  modes: ImportMode[];
  sample: Record<string, string>[];
}

interface ImportCheck {
  totalRows: number;
  valid: number;
  invalid: number;
  blank: number;
  problems: { row: number; errors: { field: string; message: string }[] }[];
  problemsTruncated: boolean;
  warnings: string[];
}

interface ImportRow {
  rowNumber: number;
  status: string;
  errors: { field: string; message: string }[];
  raw: Record<string, string>;
}

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const params = await searchParams;
  await requireCurrentUser();
  const token = await readAccessToken();

  if (!params.job) {
    const catalogue = await loadCatalogue(token);
    return (
      <>
        <PageHeader
          title="Import leads"
          description="Bring a spreadsheet of enquiries in. Your duplicate rules and assignment rules apply to every row, exactly as they do to a lead somebody types in."
          action={
            <Link href="/leads" className="text-sm underline">
              Back to leads
            </Link>
          }
        />
        <Card title="Choose a file">
          <UploadForm maxRows={catalogue.maxRows} />
        </Card>
      </>
    );
  }

  const [job, error] = await loadJob(params.job, token);
  if (!job) {
    return (
      <>
        <PageHeader title="Import leads" />
        <ErrorNotice>{error ?? 'That import could not be found.'}</ErrorNotice>
      </>
    );
  }

  const running = job.status === 'running' || job.status === 'queued';
  const finished = job.status === 'completed' || job.status === 'cancelled';

  return (
    <>
      <RunProgress active={running} />
      <PageHeader
        title="Import leads"
        description={job.fileName ?? undefined}
        action={
          <div className="flex items-center gap-3">
            <Badge tone={toneFor(job.status)}>{labelFor(job.status)}</Badge>
            <Link href="/leads/import" className="text-sm underline">
              Start again
            </Link>
          </div>
        }
      />

      {job.error && <ErrorNotice>{job.error}</ErrorNotice>}

      {running || finished ? (
        <RunSummary job={job} token={token} />
      ) : (
        <MappingStep job={job} token={token} />
      )}
    </>
  );
}

/** Steps two and three: the mapping, then what the dry run found. */
async function MappingStep({ job, token }: { job: ImportJob; token: string | null }) {
  const preview = await loadPreview(job.id, token);
  if (!preview) {
    return <ErrorNotice>That file could no longer be read. Please upload it again.</ErrorNotice>;
  }

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="Which column is which"
        description={`${preview.totalRows.toLocaleString('en-IN')} rows, ${preview.header.length} columns. We have filled in what we recognised — change anything that is wrong.`}
      >
        <MappingForm
          jobId={job.id}
          header={preview.header}
          sample={preview.sample}
          mapping={preview.mapping}
          fields={preview.fields}
          modes={preview.modes}
          mode={preview.mode}
        />
      </Card>

      {preview.ambiguous.length > 0 && (
        <Card title="Two columns look the same">
          <ul className="flex flex-col gap-1 text-sm">
            {preview.ambiguous.map((entry) => (
              <li key={entry.field}>
                {entry.headers.join(' and ')} both look like{' '}
                <span className="font-medium">
                  {preview.fields.find((field) => field.field === entry.field)?.label ??
                    entry.field}
                </span>
                . Choose which one to import, so the other is not mistaken for it.
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Check before importing"
        description="Reads every row and tells you what would go wrong — without creating anything."
      >
        <div className="flex flex-col gap-4">
          <CheckButton jobId={job.id} />
          {/* Shown from the moment the file is read, including before anybody saves a mapping: the
              proposal is already stored, so the common case is "upload, read what will happen,
              press Import". Requiring a Save first would be a step that exists only because the
              state machine has one. */}
          <CheckReport jobId={job.id} token={token} job={job} />
        </div>
      </Card>
    </div>
  );
}

/** The dry run's own report, re-read from the API rather than kept in the action's result. */
async function CheckReport({
  jobId,
  token,
  job,
}: {
  jobId: string;
  token: string | null;
  job: ImportJob;
}) {
  const report = await loadCheck(jobId, token);
  if (!report) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Ready to import" value={report.valid.toLocaleString('en-IN')} />
        <StatCard label="Need fixing" value={report.invalid.toLocaleString('en-IN')} />
        <StatCard label="Blank rows" value={report.blank.toLocaleString('en-IN')} />
      </div>

      {report.warnings.map((warning) => (
        <p key={warning} className="text-sm text-[var(--color-text-muted)]">
          {warning}
        </p>
      ))}

      {report.problems.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left">
                <th className="py-2 pr-4 font-medium">Row</th>
                <th className="py-2 font-medium">What needs fixing</th>
              </tr>
            </thead>
            <tbody>
              {report.problems.map((problem) => (
                <tr key={problem.row} className="border-b border-[var(--color-border)]/60">
                  <td className="py-2 pr-4 tabular-nums">{problem.row}</td>
                  <td className="py-2">{problem.errors.map((entry) => entry.message).join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.problemsTruncated && (
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              Showing the first {report.problems.length}. Fix these and check again.
            </p>
          )}
        </div>
      )}

      {report.valid > 0 && <StartButton jobId={job.id} rows={report.valid} />}
    </div>
  );
}

/** Step four: the run, and what it did. */
async function RunSummary({ job, token }: { job: ImportJob; token: string | null }) {
  const failed = job.totals.failed > 0 ? await loadRows(job.id, token) : [];
  const percent =
    job.totals.rows === 0 ? 0 : Math.round((job.totals.processed / job.totals.rows) * 100);

  return (
    <div className="flex flex-col gap-5">
      <Card
        title={job.status === 'completed' ? 'Imported' : 'Importing'}
        description={`${job.totals.processed.toLocaleString('en-IN')} of ${job.totals.rows.toLocaleString('en-IN')} rows (${percent}%).`}
      >
        <div className="flex flex-col gap-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-5">
            <StatCard label="Created" value={job.totals.created.toLocaleString('en-IN')} />
            <StatCard label="Updated" value={job.totals.updated.toLocaleString('en-IN')} />
            <StatCard
              label="Added to existing"
              value={job.totals.attached.toLocaleString('en-IN')}
            />
            <StatCard label="Skipped" value={job.totals.skipped.toLocaleString('en-IN')} />
            <StatCard label="Failed" value={job.totals.failed.toLocaleString('en-IN')} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {job.status === 'running' || job.status === 'queued' ? (
              <CancelButton jobId={job.id} />
            ) : (
              <Link href="/leads" className="text-sm underline">
                See the leads
              </Link>
            )}
            {job.hasErrorFile && (
              <a
                href={`/leads/import/${job.id}/errors.csv`}
                className="text-sm underline"
                data-testid="error-file"
              >
                Download the rows that failed
              </a>
            )}
          </div>
        </div>
      </Card>

      {failed.length > 0 && (
        <Card
          title="Rows that could not be imported"
          description="Fix these in the downloaded file and import it again — the mapping you chose is remembered."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left">
                  <th className="py-2 pr-4 font-medium">Row</th>
                  <th className="py-2 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {failed.map((row) => (
                  <tr key={row.rowNumber} className="border-b border-[var(--color-border)]/60">
                    <td className="py-2 pr-4 tabular-nums">{row.rowNumber}</td>
                    <td className="py-2">{row.errors.map((entry) => entry.message).join(' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function labelFor(status: string): string {
  switch (status) {
    case 'uploaded':
      return 'Not imported yet';
    case 'mapped':
      return 'Mapping saved';
    case 'validated':
      return 'Checked';
    case 'queued':
      return 'Starting';
    case 'running':
      return 'Importing';
    case 'completed':
      return 'Finished';
    case 'cancelled':
      return 'Stopped';
    default:
      return status;
  }
}

function toneFor(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running' || status === 'queued') return 'warning';
  return 'neutral';
}

async function loadCatalogue(token: string | null): Promise<{ maxRows: number }> {
  try {
    const response = await request<{ maxRows: number }>('/imports/catalogue', { token });
    return { maxRows: response.data.maxRows };
  } catch {
    return { maxRows: 50_000 };
  }
}

async function loadJob(
  id: string,
  token: string | null,
): Promise<[ImportJob | null, string | null]> {
  try {
    const response = await request<ImportJob>(`/imports/${id}`, { token });
    return [response.data, null];
  } catch (error) {
    return [null, describeError(error)];
  }
}

async function loadPreview(id: string, token: string | null): Promise<ImportPreview | null> {
  try {
    const response = await request<ImportPreview>(`/imports/${id}/preview`, { token });
    return response.data;
  } catch {
    return null;
  }
}

async function loadCheck(id: string, token: string | null): Promise<ImportCheck | null> {
  try {
    // A **GET**: rendering a page must not run a mutation, and the dry run has a read-only twin
    // for exactly this reason. `POST /imports/:id/validate` is what the Check button presses.
    const response = await request<ImportCheck>(`/imports/${id}/check`, { token });
    return response.data;
  } catch {
    return null;
  }
}

async function loadRows(id: string, token: string | null): Promise<ImportRow[]> {
  try {
    const response = await request<ImportRow[]>(`/imports/${id}/rows?status=failed&limit=50`, {
      token,
    });
    return response.data;
  } catch {
    return [];
  }
}
