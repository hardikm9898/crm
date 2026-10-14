'use client';

import { useActionState, useMemo, useState } from 'react';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import type { ActionState } from '@/lib/action-state';
import type { BuilderOptions, FormFieldRow } from '@/lib/forms';
import { saveFormFields } from '../actions';

const IDLE: ActionState = { status: 'idle' };

/** A question as the builder holds it, before it is a row. */
interface Draft {
  key: string;
  standardFieldKey: string | null;
  customFieldDefinitionId: string | null;
  label: string;
  isRequired: boolean;
  stepIndex: number;
  /** What it is, so the list can say so without looking anything up again. */
  kind: string;
  /** True when the definition itself is required: the form cannot make it optional. */
  alwaysRequired: boolean;
}

/**
 * The question builder (`FR-CAP-2`).
 *
 * A client component holding the list as state, saved in **one** call: a form's questions are an
 * ordered list that somebody edits as a whole, and per-field saves would let "move this to step 2"
 * half-apply.
 *
 * Two things it refuses to let somebody build, because the API refuses them and a refusal that
 * arrives after pressing Save is a worse way to learn: the same question twice (already-chosen
 * questions are not offered again), and a form with no way to reach anybody (said as a sentence
 * under the list, and the save button says why it is disabled).
 */
export function FormBuilder({
  formId,
  options,
  initial,
}: {
  formId: string;
  options: BuilderOptions;
  initial: readonly FormFieldRow[];
}) {
  const [state, action, pending] = useActionState(saveFormFields, IDLE);
  const [drafts, setDrafts] = useState<Draft[]>(() => initial.map(toDraft(options)));

  const used = new Set(
    drafts.map((draft) => draft.standardFieldKey ?? `custom:${draft.customFieldDefinitionId}`),
  );
  const reachable = useMemo(
    () =>
      drafts.some(
        (draft) =>
          draft.standardFieldKey !== null && options.contactKeys.includes(draft.standardFieldKey),
      ),
    [drafts, options.contactKeys],
  );
  const steps = Math.max(1, ...drafts.map((draft) => draft.stepIndex + 1));

  function add(spec: { standard?: string; custom?: string }): void {
    const standard = spec.standard
      ? options.standardFields.find((field) => field.key === spec.standard)
      : undefined;
    const custom = spec.custom
      ? options.customFields.find((field) => field.id === spec.custom)
      : undefined;
    if (!standard && !custom) return;
    setDrafts((current) => [
      ...current,
      {
        key: `${Date.now()}-${current.length}`,
        standardFieldKey: standard?.key ?? null,
        customFieldDefinitionId: custom?.id ?? null,
        label: standard?.label ?? custom?.label ?? 'Question',
        // A definition that is required is required wherever it is asked, including here.
        isRequired: custom?.isRequired ?? false,
        stepIndex: 0,
        kind: standard?.kind ?? custom?.type ?? 'text',
        alwaysRequired: custom?.isRequired ?? false,
      },
    ]);
  }

  function patch(key: string, change: Partial<Draft>): void {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)),
    );
  }

  function move(key: string, by: number): void {
    setDrafts((current) => {
      const index = current.findIndex((draft) => draft.key === key);
      const next = index + by;
      if (index < 0 || next < 0 || next >= current.length) return current;
      const copy = [...current];
      const [moved] = copy.splice(index, 1);
      copy.splice(next, 0, moved!);
      return copy;
    });
  }

  return (
    <form action={action} className="flex flex-col gap-4" data-form-builder>
      <input type="hidden" name="id" value={formId} />
      {/* The list travels as JSON: the builder already holds it as state, and flattening it into
          indexed inputs only to parse it back would be two formats to keep in step. */}
      <input
        type="hidden"
        name="fields"
        value={JSON.stringify(
          drafts.map((draft, index) => ({
            standardFieldKey: draft.standardFieldKey,
            customFieldDefinitionId: draft.customFieldDefinitionId,
            label: draft.label,
            isRequired: draft.isRequired,
            stepIndex: draft.stepIndex,
            sortOrder: index,
          })),
        )}
      />

      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]" data-fields-saved>
          {state.message}
        </p>
      )}

      {drafts.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No questions yet. Add the ones below — a name and a phone number are enough to start.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {drafts.map((draft, index) => (
            <li
              key={draft.key}
              className="rounded-md border border-[var(--color-border)] p-3"
              data-question={draft.standardFieldKey ?? draft.customFieldDefinitionId ?? draft.key}
            >
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-1">
                  <Field label="What the visitor reads">
                    <input
                      value={draft.label}
                      onChange={(event) => patch(draft.key, { label: event.target.value })}
                      maxLength={120}
                      className={controlClassName}
                      data-question-label={draft.standardFieldKey ?? draft.customFieldDefinitionId}
                    />
                  </Field>
                </div>
                <Field label="Step">
                  <select
                    value={String(draft.stepIndex)}
                    onChange={(event) =>
                      patch(draft.key, { stepIndex: Number(event.target.value) })
                    }
                    className={controlClassName}
                    data-question-step={draft.standardFieldKey ?? draft.customFieldDefinitionId}
                  >
                    {Array.from({ length: Math.min(5, steps + 1) }, (_, step) => (
                      <option key={step} value={step}>
                        {step + 1}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.isRequired}
                    disabled={draft.alwaysRequired}
                    onChange={(event) => patch(draft.key, { isRequired: event.target.checked })}
                    data-question-required={draft.standardFieldKey ?? draft.customFieldDefinitionId}
                  />
                  Must be answered
                </label>
                <div className="flex items-center gap-1">
                  <Button
                    variant="quiet"
                    onClick={() => move(draft.key, -1)}
                    disabled={index === 0}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => move(draft.key, 1)}
                    disabled={index === drafts.length - 1}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() =>
                      setDrafts((current) => current.filter((item) => item.key !== draft.key))
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {draft.standardFieldKey
                  ? `Goes on the lead as ${describeTarget(options, draft.standardFieldKey)}`
                  : 'One of your own lead fields'}
                {draft.alwaysRequired && ' · this field is required wherever it is asked'}
              </p>
            </li>
          ))}
        </ul>
      )}

      {!reachable && drafts.length > 0 && (
        <p className="text-sm text-amber-700" data-builder-unreachable>
          Ask for at least a phone number, an email address or a name. A capture with none of those
          cannot become a lead.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
        <span className="text-sm font-medium">Add a question:</span>
        {options.standardFields
          .filter((field) => !used.has(field.key))
          .map((field) => (
            <Button
              key={field.key}
              variant="secondary"
              onClick={() => add({ standard: field.key })}
            >
              {field.label}
            </Button>
          ))}
        {options.customFields
          .filter((field) => !used.has(`custom:${field.id}`))
          .map((field) => (
            <Button key={field.id} variant="secondary" onClick={() => add({ custom: field.id })}>
              {field.label}
            </Button>
          ))}
        {options.customFields.length === 0 && (
          <span className="text-xs text-[var(--color-text-muted)]">
            Your own lead fields appear here once you create them.
          </span>
        )}
      </div>

      <div>
        <Button type="submit" pending={pending} disabled={drafts.length > 0 && !reachable}>
          {pending ? 'Saving…' : 'Save the questions'}
        </Button>
      </div>
    </form>
  );
}

function toDraft(options: BuilderOptions) {
  return (field: FormFieldRow): Draft => {
    const standard = field.standardFieldKey
      ? options.standardFields.find((entry) => entry.key === field.standardFieldKey)
      : undefined;
    const custom = field.customFieldDefinitionId
      ? options.customFields.find((entry) => entry.id === field.customFieldDefinitionId)
      : undefined;
    return {
      key: field.id,
      standardFieldKey: field.standardFieldKey,
      customFieldDefinitionId: field.customFieldDefinitionId,
      label: field.label,
      isRequired: field.isRequired,
      stepIndex: field.stepIndex,
      kind: standard?.kind ?? custom?.type ?? 'text',
      alwaysRequired: custom?.isRequired ?? false,
    };
  };
}

function describeTarget(options: BuilderOptions, key: string): string {
  const spec = options.standardFields.find((field) => field.key === key);
  if (!spec) return key;
  if (spec.target === 'consent') return 'a consent record';
  if (spec.target === 'message') return 'a note on the timeline';
  return spec.label.toLowerCase();
}
