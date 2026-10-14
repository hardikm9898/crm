import { request } from '@/lib/api';

/**
 * Capture forms, on the web side (`FR-CAP-2`).
 *
 * The vocabulary is **declared here rather than imported from `@leados/shared`**, for the reason
 * `tasks.ts` and `calls.ts` state: that package's entry point reaches `node:async_hooks` through
 * the tenant context, and a client component that transitively imports it fails `next build`
 * outright. `forms.spec.ts` runs in Node, may import both, and reconciles the two — which matters
 * most for the **standard field list**, because a key this app offers that the API will refuse is a
 * builder that cannot save, and a key the API accepts that this app does not know is a question
 * that renders as nothing.
 */

export const FORM_TYPES = ['embed', 'landing', 'popup'] as const;
export type FormType = (typeof FORM_TYPES)[number];

export const FORM_SUBMISSION_STATUSES = [
  'received',
  'processed',
  'duplicate',
  'rejected',
  'error',
] as const;
export type FormSubmissionStatus = (typeof FORM_SUBMISSION_STATUSES)[number];

/** What became of a submission, as somebody reading the list would say it. */
export const SUBMISSION_STATUS_LABELS: Record<FormSubmissionStatus, string> = {
  received: 'Still being processed',
  processed: 'Became a lead',
  duplicate: 'Added to an existing lead',
  rejected: 'Refused',
  error: 'Something went wrong',
};

/**
 * `error` is rose and `rejected` is amber, deliberately.
 *
 * A refusal is the product working — a missing answer, a bot, a duplicate rule — and an error is
 * the product failing. Colouring them the same would bury the handful of rows somebody has to act
 * on under the hundreds they do not.
 */
export const SUBMISSION_STATUS_CLASSES: Record<FormSubmissionStatus, string> = {
  received: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  processed: 'bg-emerald-100 text-emerald-900',
  duplicate: 'bg-sky-100 text-sky-900',
  rejected: 'bg-amber-100 text-amber-900',
  error: 'bg-rose-100 text-rose-900',
};

export const FORM_TYPE_LABELS: Record<FormType, string> = {
  embed: 'Embedded in a page',
  landing: 'A page of its own',
  popup: 'A pop-up',
};

/** The hidden field a bot fills in and a person never sees. Must match the API's own name. */
export const HONEYPOT_FIELD = 'website_url';

export interface FormFieldRow {
  id: string;
  standardFieldKey: string | null;
  customFieldDefinitionId: string | null;
  label: string;
  placeholder: string | null;
  helpText: string | null;
  isRequired: boolean;
  sortOrder: number;
  stepIndex: number;
  options: { value: string; label: string }[] | null;
}

export interface FormRecord {
  id: string;
  name: string;
  slug: string;
  publicKey: string;
  type: FormType;
  isActive: boolean;
  submissionCount: number;
  lastSubmissionAt: string | null;
  stepCount: number;
  settings: {
    submitLabel?: string;
    thankYouMessage?: string;
    redirectUrl?: string | null;
    consentText?: string | null;
    introText?: string | null;
  };
  pipeline: { id: string; name: string } | null;
  source: { id: string; name: string } | null;
  assignmentRule: { id: string; name: string } | null;
  fields: FormFieldRow[];
  createdAt: string;
  updatedAt: string;
}

export interface BuilderOptions {
  standardFields: {
    key: string;
    label: string;
    kind: string;
    target: string;
    describe: string | null;
  }[];
  customFields: {
    id: string;
    key: string;
    label: string;
    type: string;
    isRequired: boolean;
    placeholder: string | null;
    helpText: string | null;
    options: { value: string; label: string }[];
  }[];
  contactKeys: string[];
}

export interface SubmissionRow {
  id: string;
  form: { id: string; name: string } | null;
  lead: { id: string; fullName: string } | null;
  status: FormSubmissionStatus;
  error: string | null;
  answers: Record<string, unknown>;
  utm: Record<string, string>;
  pageUrl: string | null;
  referrer: string | null;
  createdAt: string;
}

export interface PublicFormDefinition {
  name: string;
  organizationName: string;
  type: FormType;
  honeypotField: string;
  steps: number;
  settings: FormRecord['settings'];
  fields: {
    name: string;
    label: string;
    kind: string;
    required: boolean;
    stepIndex: number;
    placeholder: string | null;
    helpText: string | null;
    maxLength: number | null;
    options: { value: string; label: string }[] | null;
  }[];
}

/**
 * The URL a visitor fills the form in at.
 *
 * The **key**, never the slug: the slug is unique per workspace and would belong to several at
 * once (ADR-0029). Built from the browser origin rather than configured, so a workspace copying
 * the link out of a staging environment gets the staging link and notices.
 */
export function publicFormUrl(origin: string, publicKey: string): string {
  return `${origin.replace(/\/+$/, '')}/f/${publicKey}`;
}

/**
 * The snippet a business pastes into their website.
 *
 * An `<iframe>` rather than a script that injects markup: a script would have to render the form
 * inside somebody else's CSS, and a form that inherits a stranger's stylesheet is a form that
 * looks broken on half the sites it is on. The iframe is one line, works on every site builder,
 * and cannot be styled into invisibility by the host page.
 */
export function embedSnippet(url: string, name: string): string {
  const title = name.replace(/"/g, '&quot;');
  return `<iframe src="${url}" title="${title}" width="100%" height="640" style="border:0;max-width:640px" loading="lazy"></iframe>`;
}

/** "412 submissions · 3 in the last day", or the honest empty state. */
export function describeFormActivity(
  form: Pick<FormRecord, 'submissionCount' | 'lastSubmissionAt'>,
): string {
  if (form.submissionCount === 0) return 'Nothing has come in through it yet.';
  const count = `${form.submissionCount} ${form.submissionCount === 1 ? 'submission' : 'submissions'}`;
  if (!form.lastSubmissionAt) return `${count}.`;
  return `${count}, the last one ${relativeWhen(form.lastSubmissionAt)}.`;
}

/** A rough "how long ago", in the words a person uses. */
export function relativeWhen(iso: string, now = new Date()): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * What a submission's answers read as on the submissions screen.
 *
 * The payload's keys are `standard:phone` and `custom:<uuid>`, which is right on the wire and
 * unreadable on a screen — so the labels come from the form's own fields where they still exist,
 * and the raw key is shown for an answer to a question that has since been deleted rather than
 * dropped. "What did they actually type" is the whole reason the payload is kept.
 */
export function describeAnswers(
  answers: Record<string, unknown>,
  fields: readonly FormFieldRow[],
  options: readonly BuilderOptions['customFields'][number][] = [],
): { label: string; value: string; unmapped: boolean }[] {
  const labels = new Map<string, string>();
  for (const field of fields) {
    const name =
      field.standardFieldKey !== null
        ? `standard:${field.standardFieldKey}`
        : `custom:${field.customFieldDefinitionId}`;
    labels.set(name, field.label);
  }
  for (const definition of options) labels.set(`custom:${definition.id}`, definition.label);

  return Object.entries(answers)
    .filter(([key]) => key !== HONEYPOT_FIELD)
    .map(([key, value]) => ({
      label: labels.get(key) ?? key,
      value: Array.isArray(value) ? value.map(String).join(', ') : String(value ?? ''),
      unmapped: !labels.has(key),
    }));
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/**
 * Throwing, not swallowing.
 *
 * Every one of these is read by a screen whose job is to list something, where an empty list and a
 * failed request look identical — the mistake the product catalogue shipped with, where a
 * swallowed 400 told every workspace it had no products.
 */
export async function loadForms(token: string | null, query = ''): Promise<FormRecord[]> {
  return (await request<FormRecord[]>(`/forms${query}`, { token })).data;
}

export async function loadForm(token: string | null, id: string): Promise<FormRecord> {
  return (await request<FormRecord>(`/forms/${id}`, { token })).data;
}

export async function loadBuilderOptions(token: string | null): Promise<BuilderOptions> {
  return (await request<BuilderOptions>('/forms/builder-options', { token })).data;
}

export async function loadSubmissions(token: string | null, query = ''): Promise<SubmissionRow[]> {
  return (await request<SubmissionRow[]>(`/forms/submissions${query}`, { token })).data;
}

/** The public definition, read with no token at all — which is the whole point of it. */
export async function loadPublicForm(publicKey: string): Promise<PublicFormDefinition> {
  return (await request<PublicFormDefinition>(`/public/forms/${publicKey}`)).data;
}
