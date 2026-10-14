'use client';

import { useActionState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import {
  FIELD_TYPE_CHOICES,
  suggestedFieldKey,
  suggestedFieldLabel,
  suggestedFieldType,
  type UnmappedField,
} from '@/lib/ingestion';
import { createFieldFromUnmapped, replayPayload, testIngestion } from '../actions';

/**
 * Finishing a payload that never became a lead.
 *
 * Its own small form so a refusal lands beside the row it belongs to: one notice at the top of a
 * log of twenty-five would not say which one it was about.
 *
 * There is deliberately **no success message here**. A successful replay revalidates this screen,
 * the payload leaves the "did not become leads" list, and this component is unmounted with its
 * action state — so a confirmation rendered from `useActionState` could never be read. The
 * confirmation is rendered from the server tree instead, on the payload's own row in the log
 * ("Tried again just now — it became a lead"), where it also survives a refresh and is the honest
 * record rather than a sentence that disappears. A failure keeps the row, so its notice stays.
 */
export function ReplayButton({ payloadId }: { payloadId: string }) {
  const [state, action, pending] = useActionState(replayPayload, IDLE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={payloadId} />
      <Button type="submit" variant="secondary" pending={pending}>
        {pending ? 'Replaying…' : 'Try again'}
      </Button>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
    </form>
  );
}

/**
 * One field an integration keeps sending that this workspace has nowhere to put (`FR-CAP-5`).
 *
 * The key, the label and the kind are all **editable before the one click**, pre-filled from the
 * field's own name and a guess at its type from the samples. A single irreversible button would be
 * worse than two: a custom field's key appears in stored values, saved views, import mappings and
 * index names, so it cannot be changed afterwards — deactivating and creating another is the only
 * honest correction.
 */
export function UnmappedFieldRow({
  field,
  canCreateFields,
}: {
  field: UnmappedField;
  /**
   * Whether this caller may create a field at all. Hiding the button is presentation, not
   * authorization — `POST /custom-fields` is guarded by `custom_field:manage` regardless — but a
   * button that leads to a 403 is worse than no button.
   */
  canCreateFields: boolean;
}) {
  const [state, action, pending] = useActionState(createFieldFromUnmapped, IDLE);
  const key = suggestedFieldKey(field.field);
  const suggestion = suggestedFieldType(field.samples);

  return (
    <div className="flex flex-col gap-2 border-b border-[var(--color-border)]/60 py-3 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <code data-unmapped-field={field.field}>{field.field}</code>{' '}
          <span className="text-[var(--color-text-muted)]">
            — seen {field.count} {field.count === 1 ? 'time' : 'times'}
            {field.samples.length > 0 ? `, like “${field.samples.join('”, “')}”` : ''}
          </span>
        </p>
      </div>

      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' ? (
        <p className="text-sm text-[var(--color-success)]" data-field-created={field.field}>
          {state.message}
        </p>
      ) : !canCreateFields ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Somebody who can manage this workspace’s fields can turn this into one.
        </p>
      ) : key === null ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          This name cannot be a field key — it collides with one of the lead’s own columns, or
          starts with something a key may not. Create it on the field builder under a name of your
          own.
        </p>
      ) : (
        <form action={action} className="flex flex-wrap items-end gap-2">
          <Field label="Key">
            <input
              name="key"
              className={controlClassName}
              defaultValue={key}
              aria-label={`Key for ${field.field}`}
            />
          </Field>
          <Field label="Label">
            <input
              name="label"
              className={controlClassName}
              defaultValue={suggestedFieldLabel(field.field)}
              aria-label={`Label for ${field.field}`}
            />
          </Field>
          <Field label="Kind">
            <select
              name="type"
              defaultValue={suggestion}
              className={controlClassName}
              aria-label={`Kind of field for ${field.field}`}
            >
              {FIELD_TYPE_CHOICES.map((choice) => (
                <option key={choice.type} value={choice.type}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" pending={pending}>
            {pending ? 'Creating…' : 'Make this a field'}
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * "Why did my lead not appear" (`FR-CAP-6`).
 *
 * The same mapping the real capture does, answering what each step decided and persisting nothing —
 * so an integrator can find out that their `source` matches no source in this workspace before
 * they go live, rather than through a support conversation.
 */
export function IngestionTestTool() {
  const [state, action, pending] = useActionState(testIngestion, IDLE);
  const sample = `{
  "name": "Rohit Kulkarni",
  "phone": "98450 12345",
  "source": "Website",
  "message": "Need a 3BHK before Diwali",
  "propertyType": "Apartment"
}`;
  const submitted = state.status === 'error' ? (state.values?.['payload'] ?? sample) : sample;

  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Field
        label="The JSON your integration would send"
        hint="Nothing is saved. This runs the same mapping a real request does and tells you what it decided."
      >
        <textarea
          name="payload"
          rows={8}
          className={`${controlClassName} font-mono text-xs`}
          defaultValue={submitted}
        />
      </Field>
      <div>
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? 'Trying…' : 'Try it'}
        </Button>
      </div>

      {state.status === 'success' && (
        <div className="flex flex-col gap-2" data-dry-run>
          <p
            className={
              state.data?.['verdict'] === 'create'
                ? 'text-sm font-medium text-[var(--color-success)]'
                : 'text-sm font-medium text-[var(--color-danger)]'
            }
            data-dry-run-verdict={state.data?.['verdict']}
          >
            {state.data?.['verdict'] === 'create'
              ? 'This would create a lead.'
              : 'This would be refused — see why below.'}
          </p>
          <p className="text-sm text-[var(--color-text-muted)]">{state.message}</p>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            What would be saved
          </p>
          <pre
            className="overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-xs"
            data-dry-run-normalized
          >
            {state.data?.['normalized']}
          </pre>
          {state.data?.['unmapped'] && (
            <p className="text-sm" data-dry-run-unmapped>
              Kept but not understood: <code>{state.data['unmapped']}</code>. Each one can become a
              field of its own below.
            </p>
          )}
          {state.data?.['notes'] && (
            <ul className="flex flex-col gap-1 text-sm" data-dry-run-notes>
              {state.data['notes']
                .split('\n')
                .filter((note) => note !== '')
                .map((note) => (
                  <li key={note}>· {note}</li>
                ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
