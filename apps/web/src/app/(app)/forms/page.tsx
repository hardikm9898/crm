import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import {
  SUBMISSION_STATUS_CLASSES,
  SUBMISSION_STATUS_LABELS,
  describeFormActivity,
  loadForms,
  loadSubmissions,
  relativeWhen,
  type FormRecord,
  type SubmissionRow,
} from '@/lib/forms';

/**
 * The forms a workspace has (`FR-CAP-2`).
 *
 * Two things on one screen on purpose: the forms, and the **submissions that became nothing**. A
 * capture screen that only lists the forms makes a refused submission invisible, and the refusals
 * are the only rows on this screen anybody has to act on — a form whose required field nobody can
 * answer looks exactly like a quiet week.
 *
 * Read through the throwing loaders: on a screen whose job is to list forms, an empty list and a
 * failed request look identical and must not.
 */
export const dynamic = 'force-dynamic';

export default async function FormsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'form:read')) {
    return (
      <>
        <PageHeader title="Capture forms" />
        <ErrorNotice>Your role does not include capture forms.</ErrorNotice>
      </>
    );
  }

  let forms: FormRecord[];
  let unresolved: SubmissionRow[];
  try {
    [forms, unresolved] = await Promise.all([
      loadForms(token, '?limit=50'),
      loadSubmissions(token, '?status=rejected&limit=10'),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Capture forms" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const live = forms.filter((form) => form.isActive).length;

  return (
    <>
      <PageHeader
        title="Capture forms"
        description="Your own questions, on your own website — every answer landing on a lead."
        action={
          can(user, 'form:manage') ? (
            <Link
              href="/forms/new"
              className="inline-flex items-center rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-contrast)]"
            >
              New form
            </Link>
          ) : undefined
        }
      />

      <p className="mb-4 text-sm text-[var(--color-text-muted)]" data-forms-summary>
        {forms.length === 0
          ? 'No forms yet.'
          : `${forms.length} ${forms.length === 1 ? 'form' : 'forms'}, ${live} of them live.`}
      </p>

      {forms.length === 0 ? (
        <Card title="Nothing to capture with yet">
          <EmptyState
            title="A form is the quickest way to stop losing enquiries"
            description="Build one here, paste the snippet into your website, and every enquiry arrives as a lead with its promise already running."
          />
        </Card>
      ) : (
        <ul className="mb-6 flex flex-col gap-3">
          {forms.map((form) => (
            <li key={form.id} data-form={form.id}>
              <Card
                title={form.name}
                description={describeFormActivity(form)}
                action={
                  <Badge tone={form.isActive ? 'success' : 'neutral'}>
                    {form.isActive ? 'Live' : 'Switched off'}
                  </Badge>
                }
              >
                <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  <div>
                    <dt className="text-xs uppercase text-[var(--color-text-muted)]">Questions</dt>
                    <dd data-form-questions={form.id}>
                      {form.fields.length}
                      {form.stepCount > 1 ? ` over ${form.stepCount} steps` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase text-[var(--color-text-muted)]">
                      Captures land in
                    </dt>
                    <dd>{form.pipeline?.name ?? 'the default pipeline'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase text-[var(--color-text-muted)]">
                      Attributed to
                    </dt>
                    <dd>{form.source?.name ?? 'no particular source'}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-sm">
                  <Link href={`/forms/${form.id}`} className="underline">
                    Open and get the link
                  </Link>
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {unresolved.length > 0 && (
        <Card
          title="Submissions that became nothing"
          description="Refused, and worth a look: a required question nobody can answer looks exactly like a quiet week."
        >
          <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
            {unresolved.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"
                data-unresolved={row.id}
              >
                <span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${SUBMISSION_STATUS_CLASSES[row.status]}`}
                  >
                    {SUBMISSION_STATUS_LABELS[row.status]}
                  </span>{' '}
                  {row.form?.name ?? 'A form'} — {row.error ?? 'no reason recorded'}
                </span>
                <span className="text-[var(--color-text-muted)]">
                  {relativeWhen(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
