'use client';

import { useState } from 'react';
import { apiBaseUrl } from '@/lib/api';
import type { PublicFormDefinition } from '@/lib/forms';

/**
 * The form itself, in the visitor's browser.
 *
 * A client component posting **straight to the API** rather than through a server action, which is
 * the opposite of every other form in this app and deliberate: there is no session to attach, the
 * endpoint is public, and routing a stranger's submission through our own server would add a hop
 * that can fail without adding anything. It also means this page works inside an `<iframe>` on
 * somebody else's domain, which is where most of these will live. `apiBaseUrl()` reads
 * `NEXT_PUBLIC_API_URL`, which is public precisely because the browser needs it: the value a
 * server-side fetch could use may be a hostname only the container network resolves.
 *
 * Three things a visitor-facing form has to get right, and this is where they are:
 *
 *  * **Nothing is lost on a refusal.** The answers are React state, so a 400 puts the messages
 *    under the fields and leaves everything typed exactly where it was — the trap every
 *    server-action form in this product had to be taught.
 *  * **A multi-step form does not validate the next step's questions.** "Next" moves on when this
 *    step's own required answers are there; the API has the last word on all of them.
 *  * **The honeypot is invisible but not `display: none`.** A field a bot can see in the markup and
 *    a person cannot see on the screen is the whole trick; `hidden` is a flag some bots read.
 */
export function PublicForm({
  publicKey,
  definition,
}: {
  publicKey: string;
  definition: PublicFormDefinition;
}) {
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const steps = Math.max(1, definition.steps);
  const fieldsOnStep = definition.fields.filter((field) => field.stepIndex === step);
  const isLast = step >= steps - 1;

  function set(name: string, value: string | boolean): void {
    setAnswers((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  /** This step's own required answers, so "Next" cannot be refused for a question not yet shown. */
  function stepIsComplete(): boolean {
    const missing: Record<string, string> = {};
    for (const field of fieldsOnStep) {
      if (!field.required) continue;
      const value = answers[field.name];
      const empty =
        field.kind === 'checkbox'
          ? value !== true
          : value === undefined || String(value).trim() === '';
      if (empty) {
        missing[field.name] =
          field.kind === 'checkbox' ? `Please tick “${field.label}”.` : `${field.label} is needed.`;
      }
    }
    setErrors(missing);
    return Object.keys(missing).length === 0;
  }

  async function submit(): Promise<void> {
    if (!stepIsComplete()) return;
    setSending(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBaseUrl()}/api/v1/public/forms/${publicKey}/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          answers,
          // The page's own query string, which is where an ad click's UTM parameters are.
          utm: utmFromLocation(),
          pageUrl: typeof window === 'undefined' ? undefined : window.location.href,
          referrer: typeof document === 'undefined' ? undefined : document.referrer || undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        success?: boolean;
        data?: { message?: string; redirectUrl?: string | null };
        error?: { message?: string; details?: { field?: string; message?: string }[] };
      } | null;

      if (!response.ok || payload?.success !== true) {
        const details = payload?.error?.details ?? [];
        const perField: Record<string, string> = {};
        for (const detail of details) {
          if (typeof detail.field === 'string' && typeof detail.message === 'string') {
            perField[detail.field] = detail.message;
          }
        }
        setErrors(perField);
        // A sentence at the top as well: a field error for a question on another step would
        // otherwise be invisible, which is how a form becomes a dead end.
        setMessage(
          payload?.error?.message ??
            'We could not send that. Please check your answers and try again.',
        );
        // Back to the first step that has something wrong with it.
        const firstBad = definition.fields.find((field) => perField[field.name] !== undefined);
        if (firstBad) setStep(firstBad.stepIndex);
        return;
      }

      const redirect = payload.data?.redirectUrl;
      if (redirect) {
        window.location.href = redirect;
        return;
      }
      setDone(payload.data?.message ?? 'Thank you — we have your details.');
    } catch {
      setMessage('We could not reach the server. Please check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  if (done !== null) {
    return (
      <div
        role="status"
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5 text-sm"
        data-form-thanks
      >
        {done}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (isLast) void submit();
        else if (stepIsComplete()) setStep((current) => current + 1);
      }}
      className="flex flex-col gap-4"
      data-public-form
    >
      {steps > 1 && (
        <p className="text-xs text-[var(--color-text-muted)]" data-form-step>
          Step {step + 1} of {steps}
        </p>
      )}

      {message && (
        <p role="alert" className="text-sm text-[var(--color-danger)]" data-form-error>
          {message}
        </p>
      )}

      {fieldsOnStep.map((field) => (
        <label key={field.name} className="flex flex-col gap-1.5 text-sm">
          {field.kind === 'checkbox' ? (
            <span className="flex items-start gap-2">
              <input
                type="checkbox"
                name={field.name}
                checked={answers[field.name] === true}
                onChange={(event) => set(field.name, event.target.checked)}
                className="mt-1"
              />
              <span>
                {field.label}
                {field.required && ' *'}
              </span>
            </span>
          ) : (
            <>
              <span className="font-medium">
                {field.label}
                {field.required && ' *'}
              </span>
              {renderControl(field, answers[field.name], (value) => set(field.name, value))}
            </>
          )}
          {errors[field.name] ? (
            <span className="text-xs text-[var(--color-danger)]" data-field-error={field.name}>
              {errors[field.name]}
            </span>
          ) : (
            field.helpText && (
              <span className="text-xs text-[var(--color-text-muted)]">{field.helpText}</span>
            )
          )}
        </label>
      ))}

      {/*
        The honeypot. Off-screen rather than `hidden` or `display: none`: a bot that reads the
        attribute skips it, and the whole value of this field is that it is filled in by something
        that fills in everything. `tabIndex={-1}` and `aria-hidden` keep it away from a person
        using a keyboard or a screen reader.
      */}
      <input
        type="text"
        name={definition.honeypotField}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={
          typeof answers[definition.honeypotField] === 'string'
            ? String(answers[definition.honeypotField])
            : ''
        }
        onChange={(event) => set(definition.honeypotField, event.target.value)}
        style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px', opacity: 0 }}
      />

      {definition.settings.consentText && (
        <p className="text-xs text-[var(--color-text-muted)]">{definition.settings.consentText}</p>
      )}

      <div className="flex items-center gap-2">
        {step > 0 && (
          <button
            type="button"
            onClick={() => setStep((current) => current - 1)}
            className="min-h-11 rounded-md border border-[var(--color-border)] px-4 text-sm"
          >
            Back
          </button>
        )}
        <button
          type="submit"
          disabled={sending}
          className="min-h-11 rounded-md bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-contrast)] disabled:opacity-60"
          data-form-submit
        >
          {sending ? 'Sending…' : isLast ? (definition.settings.submitLabel ?? 'Send') : 'Next'}
        </button>
      </div>
    </form>
  );
}

function renderControl(
  field: PublicFormDefinition['fields'][number],
  value: string | boolean | undefined,
  set: (value: string) => void,
) {
  const className =
    'min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm';
  const current = typeof value === 'string' ? value : '';

  if (field.kind === 'textarea') {
    return (
      <textarea
        name={field.name}
        rows={3}
        value={current}
        onChange={(event) => set(event.target.value)}
        maxLength={field.maxLength ?? undefined}
        placeholder={field.placeholder ?? undefined}
        className={className}
      />
    );
  }
  if (field.options && field.options.length > 0) {
    return (
      <select
        name={field.name}
        value={current}
        onChange={(event) => set(event.target.value)}
        className={className}
      >
        <option value="">Choose…</option>
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      // `type` drives the phone keypad and the email keyboard on a mobile, which is most of this
      // form's traffic.
      type={
        field.kind === 'email'
          ? 'email'
          : field.kind === 'phone'
            ? 'tel'
            : field.kind === 'number' || field.kind === 'rating'
              ? 'number'
              : field.kind === 'date'
                ? 'date'
                : field.kind === 'url'
                  ? 'url'
                  : 'text'
      }
      name={field.name}
      value={current}
      onChange={(event) => set(event.target.value)}
      maxLength={field.maxLength ?? undefined}
      placeholder={field.placeholder ?? undefined}
      className={className}
    />
  );
}

/** The five UTM keys off the page's own query string. The API normalises them again. */
function utmFromLocation(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const value = params.get(key);
    if (value) utm[key] = value;
  }
  return utm;
}
