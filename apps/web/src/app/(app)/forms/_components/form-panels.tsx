'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import type { ActionState } from '@/lib/action-state';
import { embedSnippet, type FormRecord } from '@/lib/forms';
import { createForm, deleteForm, rotateFormKey, setFormActive, updateForm } from '../actions';

const IDLE: ActionState = { status: 'idle' };

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

/**
 * Creating a form.
 *
 * It arrives with four questions already on it — name, phone, email and "what do you need" — for
 * the same reason the follow-up form proposes tomorrow at 10:00: the commonest thing anybody wants
 * is the obvious thing, and a builder that starts empty is a builder somebody abandons. They are
 * editable immediately on the next screen.
 */
export function NewFormForm() {
  const [state, action, pending] = useActionState(createForm, IDLE);
  return (
    <form action={action} className="flex max-w-xl flex-col gap-4">
      <input
        type="hidden"
        name="fields"
        value={JSON.stringify([
          { standardFieldKey: 'fullName', label: 'Your name', isRequired: true, stepIndex: 0 },
          { standardFieldKey: 'phone', label: 'Mobile number', isRequired: true, stepIndex: 0 },
          { standardFieldKey: 'email', label: 'Email address', isRequired: false, stepIndex: 0 },
          {
            standardFieldKey: 'message',
            label: 'What do you need?',
            isRequired: false,
            stepIndex: 0,
          },
        ])}
      />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      <Field
        label="What is this form for?"
        hint="Your own name for it — “Website enquiry”, “Launch offer”."
        {...(errorOf(state, 'name') ? { error: errorOf(state, 'name')! } : {})}
      >
        <input
          name="name"
          required
          maxLength={120}
          className={controlClassName}
          placeholder="Website enquiry"
          defaultValue={valueOf(state, 'name', '')}
        />
      </Field>

      <Field
        label="The thank-you message"
        hint="What the visitor reads the moment they press send."
      >
        <input
          name="thankYouMessage"
          maxLength={500}
          className={controlClassName}
          placeholder="Thank you — we have your details and will be in touch shortly."
          defaultValue={valueOf(state, 'thankYouMessage', '')}
        />
      </Field>

      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Creating…' : 'Create the form'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The form's own copy and where its captures land.
 *
 * `pipelineId`, `leadSourceId` and `assignmentRuleId` are sent as empty strings when nothing is
 * chosen, which the action turns into `null`: "use the workspace's defaults" has to be expressible,
 * or a form built before a pipeline existed could never be put back.
 */
export function FormSettingsForm({
  form,
  pipelines,
  sources,
  rules,
}: {
  form: FormRecord;
  pipelines: { id: string; name: string }[];
  sources: { id: string; name: string }[];
  rules: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(updateForm, IDLE);
  return (
    <form action={action} className="flex flex-col gap-4" data-form-settings>
      <input type="hidden" name="id" value={form.id} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]" data-settings-saved>
          {state.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" {...(errorOf(state, 'name') ? { error: errorOf(state, 'name')! } : {})}>
          <input
            name="name"
            maxLength={120}
            className={controlClassName}
            defaultValue={valueOf(state, 'name', form.name)}
          />
        </Field>
        <Field
          label="Address"
          hint="Used in your own links and reports."
          {...(errorOf(state, 'slug') ? { error: errorOf(state, 'slug')! } : {})}
        >
          <input
            name="slug"
            maxLength={60}
            className={controlClassName}
            defaultValue={valueOf(state, 'slug', form.slug)}
          />
        </Field>
        <Field label="Which pipeline captures enter" hint="Leave blank for the workspace default.">
          <select
            name="pipelineId"
            defaultValue={form.pipeline?.id ?? ''}
            className={controlClassName}
          >
            <option value="">The default pipeline</option>
            {pipelines.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Attributed to"
          hint="The source every capture through this form is credited to."
        >
          <select
            name="leadSourceId"
            defaultValue={form.source?.id ?? ''}
            className={controlClassName}
          >
            <option value="">No particular source</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assigned by" hint="Leave blank to use the ordered rule set.">
          <select
            name="assignmentRuleId"
            defaultValue={form.assignmentRule?.id ?? ''}
            className={controlClassName}
          >
            <option value="">Whatever the rules decide</option>
            {rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {rule.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="The send button says">
          <input
            name="submitLabel"
            maxLength={40}
            className={controlClassName}
            placeholder="Send"
            defaultValue={valueOf(state, 'submitLabel', form.settings.submitLabel ?? '')}
          />
        </Field>
      </div>

      <Field label="Above the questions" hint="One sentence explaining what this form is for.">
        <input
          name="introText"
          maxLength={500}
          className={controlClassName}
          defaultValue={valueOf(state, 'introText', form.settings.introText ?? '')}
        />
      </Field>

      <Field label="The thank-you message">
        <input
          name="thankYouMessage"
          maxLength={500}
          className={controlClassName}
          defaultValue={valueOf(state, 'thankYouMessage', form.settings.thankYouMessage ?? '')}
        />
      </Field>

      <Field
        label="Or send them to a page of your own"
        hint="Leave blank to show the thank-you message instead."
        {...(errorOf(state, 'redirectUrl') ? { error: errorOf(state, 'redirectUrl')! } : {})}
      >
        <input
          name="redirectUrl"
          type="url"
          maxLength={2000}
          className={controlClassName}
          placeholder="https://example.com/thank-you"
          defaultValue={valueOf(state, 'redirectUrl', form.settings.redirectUrl ?? '')}
        />
      </Field>

      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The link, the embed snippet, and the two buttons that change who can use them.
 *
 * The URL is built from the **browser's** origin rather than from configuration, so a link copied
 * out of a staging environment is a staging link and somebody notices before it is on a website.
 */
export function FormLinkPanel({ form }: { form: FormRecord }) {
  const [rotateState, rotate, rotating] = useActionState(rotateFormKey, IDLE);
  const [activeState, setActive, switching] = useActionState(setFormActive, IDLE);
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const url = `${origin}/f/${form.publicKey}`;
  const snippet = embedSnippet(url, form.name);

  async function copy(what: 'link' | 'snippet'): Promise<void> {
    try {
      await navigator.clipboard.writeText(what === 'link' ? url : snippet);
      setCopied(what);
    } catch {
      // A clipboard a browser refuses is not an error worth a notice: the value is on the screen
      // and selectable, which is what the `readOnly` input is for.
      setCopied(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="The link to share" hint="Anybody with this link can fill the form in.">
        <input readOnly value={url} className={controlClassName} data-form-url />
      </Field>
      <Field label="Or paste this into your website">
        <textarea readOnly value={snippet} rows={3} className={controlClassName} data-form-embed />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => void copy('link')}>
          Copy the link
        </Button>
        <Button variant="secondary" onClick={() => void copy('snippet')}>
          Copy the snippet
        </Button>
        {copied && (
          <span role="status" className="text-xs text-[var(--color-success)]">
            {copied === 'link' ? 'Link copied.' : 'Snippet copied.'}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
        <form action={setActive}>
          <input type="hidden" name="id" value={form.id} />
          <input type="hidden" name="isActive" value={form.isActive ? 'false' : 'true'} />
          <Button type="submit" variant="secondary" pending={switching}>
            {form.isActive ? 'Switch the form off' : 'Switch the form on'}
          </Button>
        </form>
        <form action={rotate}>
          <input type="hidden" name="id" value={form.id} />
          <Button type="submit" variant="secondary" pending={rotating}>
            {rotating ? 'Making a new link…' : 'Replace the link'}
          </Button>
        </form>
        <span className="text-xs text-[var(--color-text-muted)]">
          Switching it off, or replacing the link, stops the old URL working straight away.
        </span>
      </div>
      {rotateState.status === 'error' && <ErrorNotice>{rotateState.message}</ErrorNotice>}
      {activeState.status === 'error' && <ErrorNotice>{activeState.message}</ErrorNotice>}
      {rotateState.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]" data-key-rotated>
          {rotateState.message}
        </p>
      )}
    </div>
  );
}

/** Deleting a form, which the API refuses once anything has come in through it. */
export function DeleteFormButton({ form }: { form: FormRecord }) {
  const [state, action, pending] = useActionState(deleteForm, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={form.id} />
      <div>
        <Button type="submit" variant="danger" pending={pending}>
          {pending ? 'Deleting…' : 'Delete this form'}
        </Button>
      </div>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
    </form>
  );
}
