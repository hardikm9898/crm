import Link from 'next/link';
import { describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, ErrorNotice, PageHeader } from '@/components/ui';
import {
  SUBMISSION_STATUS_CLASSES,
  SUBMISSION_STATUS_LABELS,
  describeAnswers,
  describeFormActivity,
  loadBuilderOptions,
  loadForm,
  loadSubmissions,
  relativeWhen,
  type BuilderOptions,
  type FormRecord,
  type SubmissionRow,
} from '@/lib/forms';
import { FormBuilder } from '../_components/form-builder';
import { DeleteFormButton, FormLinkPanel, FormSettingsForm } from '../_components/form-panels';

/**
 * One form: its questions, its link, where its captures land, and what has come in.
 *
 * The order is deliberate — the link first, because somebody who has just built a form wants to
 * put it on their website; then the questions; then where captures land; then the submissions,
 * which is where "it is on the site and nothing is arriving" gets answered.
 */
export const dynamic = 'force-dynamic';

export default async function FormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'form:read')) {
    return (
      <>
        <PageHeader title="Capture form" />
        <ErrorNotice>Your role does not include capture forms.</ErrorNotice>
      </>
    );
  }
  const mayManage = can(user, 'form:manage');

  let form: FormRecord;
  let submissions: SubmissionRow[];
  try {
    [form, submissions] = await Promise.all([
      loadForm(token, id),
      loadSubmissions(token, `?formId=${id}&limit=20`),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Capture form" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  // Only a builder needs these, and `form:manage` is what `GET /forms/builder-options` requires:
  // asking for them as a reader would be a 403 on a screen that otherwise works.
  let options: BuilderOptions | null = null;
  let pipelines: { id: string; name: string }[] = [];
  let sources: { id: string; name: string }[] = [];
  let rules: { id: string; name: string }[] = [];
  /**
   * The three placement lists are read separately from the builder options, and their failure is
   * **said** rather than swallowed or fatal.
   *
   * They come from `/crm/*` and `/assignment/rules`, which need `lead:read` — a permission
   * somebody holding `form:manage` alone may not have. Letting that take the whole screen down
   * would hide the questions and the link over a dropdown; rendering empty selects would silently
   * mean "you have no pipelines", the lie the product catalogue once told. So: empty lists, and a
   * sentence saying why.
   */
  let placementProblem: string | null = null;
  if (mayManage) {
    try {
      options = await loadBuilderOptions(token);
    } catch (error) {
      return (
        <>
          <PageHeader title={form.name} />
          <ErrorNotice>{describeError(error)}</ErrorNotice>
        </>
      );
    }
    try {
      [pipelines, sources, rules] = await Promise.all([
        request<{ id: string; name: string }[]>('/crm/pipelines', { token }).then((page) =>
          page.data.map((pipeline) => ({ id: pipeline.id, name: pipeline.name })),
        ),
        request<{ id: string; name: string }[]>('/crm/sources', { token }).then((page) =>
          page.data.map((source) => ({ id: source.id, name: source.name })),
        ),
        request<{ id: string; name: string }[]>('/assignment/rules', { token }).then((page) =>
          page.data.map((rule) => ({ id: rule.id, name: rule.name })),
        ),
      ]);
    } catch (error) {
      placementProblem = describeError(error);
    }
  }

  return (
    <>
      <PageHeader
        title={form.name}
        description={describeFormActivity(form)}
        action={
          <span className="flex items-center gap-3">
            <Badge tone={form.isActive ? 'success' : 'neutral'}>
              {form.isActive ? 'Live' : 'Switched off'}
            </Badge>
            <Link href="/forms" className="text-sm underline">
              Back to forms
            </Link>
          </span>
        }
      />

      <div className="flex flex-col gap-5">
        {mayManage && (
          <Card
            title="Where it lives"
            description="Paste the link, or the snippet, into your website."
          >
            <FormLinkPanel form={form} />
          </Card>
        )}

        <Card
          title="The questions"
          description="What a visitor is asked, in the order they are asked."
        >
          {mayManage && options ? (
            <FormBuilder formId={form.id} options={options} initial={form.fields} />
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]/60 text-sm">
              {form.fields.map((field) => (
                <li key={field.id} className="flex justify-between gap-3 py-2">
                  <span data-question-name>{field.label}</span>
                  <span className="text-[var(--color-text-muted)]">
                    {field.isRequired ? 'Required' : 'Optional'} · step {field.stepIndex + 1}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {mayManage && (
          <Card title="Where captures land" description="And what the visitor is told afterwards.">
            {placementProblem && (
              <div className="mb-3">
                <ErrorNotice>
                  The pipelines, sources and assignment rules could not be loaded, so those three
                  choices are empty: {placementProblem}
                </ErrorNotice>
              </div>
            )}
            <FormSettingsForm form={form} pipelines={pipelines} sources={sources} rules={rules} />
          </Card>
        )}

        <Card
          title="What has come in"
          description="Every submission, including the ones that became nothing — which is how “it is on the site and nothing is arriving” gets answered."
        >
          {submissions.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Nothing yet. Open the link yourself and send one through — it will appear here.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
              {submissions.map((row) => (
                <li key={row.id} className="py-3 text-sm" data-submission={row.id}>
                  <p className="flex flex-wrap items-baseline gap-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${SUBMISSION_STATUS_CLASSES[row.status]}`}
                      data-submission-status={row.id}
                    >
                      {SUBMISSION_STATUS_LABELS[row.status]}
                    </span>
                    {row.lead && (
                      <Link href={`/leads/${row.lead.id}`} className="underline">
                        {row.lead.fullName}
                      </Link>
                    )}
                    <span className="text-[var(--color-text-muted)]">
                      {relativeWhen(row.createdAt)}
                    </span>
                  </p>
                  {row.error && <p className="mt-1 text-amber-700">{row.error}</p>}
                  <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[var(--color-text-muted)]">
                    {describeAnswers(row.answers, form.fields, options?.customFields ?? []).map(
                      (answer) => (
                        <div key={answer.label} className="flex gap-1">
                          <dt>{answer.label}:</dt>
                          <dd className={answer.unmapped ? 'italic' : undefined}>
                            {answer.value}
                            {answer.unmapped && ' (not a question on this form)'}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {mayManage && (
          <Card
            title="Delete this form"
            description="Only possible while nothing has come in through it — after that, switch it off instead, which stops the link working straight away."
          >
            <DeleteFormButton form={form} />
          </Card>
        )}
      </div>
    </>
  );
}
