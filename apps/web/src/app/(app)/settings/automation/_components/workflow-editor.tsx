'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import {
  blankStep,
  cleanDefinition,
  coerceParam,
  problemsAt,
  type ActionSpec,
  type AutomationCatalogue,
  type DefinitionProblem,
  type ParamField,
  type ReferenceLists,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@/lib/automation';
import { saveDefinition } from '../actions';

/**
 * The editor (`FR-AUT-1`).
 *
 * **It knows no trigger and no action.** Everything on the screen is rendered from the catalogue
 * the API served: the trigger list, the actions somebody can add, and every input inside a step —
 * each one from a `ParamField` with a type, a label, a hint and, where the value is a row in this
 * workspace, which kind of row. That is Phase 6's first exit criterion made structural rather than
 * promised: adding `send_sms` to `WORKFLOW_ACTIONS` puts it in the "add a step" list with its own
 * fields, and nothing in `apps/web` is rebuilt.
 *
 * The graph lives in React state and travels as **one** hidden JSON field. A form whose fields
 * repeat cannot echo its submission through `submittedValues` — it keeps one value per name, which
 * is how a mapping editor came back from a refusal having silently dropped every row but the last.
 *
 * What it does not do yet: nested branches. The API, the validator and the schema all carry them
 * (`then` / `otherwise`, three deep), and a linear list is what this screen edits; the visual
 * builder arrives with the executor, and `docs/implementation-roadmap.md` says so rather than
 * leaving it to be discovered.
 */
export function WorkflowEditor({
  workflowId,
  catalogue,
  references,
  initial,
  problems,
  readOnly,
}: {
  workflowId: string;
  catalogue: AutomationCatalogue;
  references: ReferenceLists;
  initial: WorkflowDefinition;
  problems: readonly DefinitionProblem[];
  readOnly: boolean;
}) {
  const [state, submit, pending] = useActionState(saveDefinition, IDLE);
  const [definition, setDefinition] = useState<WorkflowDefinition>(initial);

  const triggerSpec = catalogue.triggers.find((entry) => entry.key === definition.trigger.type);
  const addable = catalogue.actions;

  const setTrigger = (type: string) => {
    setDefinition((current) => ({ ...current, trigger: { type, params: {} } }));
  };

  const setTriggerParam = (field: ParamField, raw: string | boolean) => {
    setDefinition((current) => ({
      ...current,
      trigger: {
        type: current.trigger.type,
        params: { ...current.trigger.params, [field.key]: coerceParam(field, raw) },
      },
    }));
  };

  const setStepParam = (index: number, field: ParamField, raw: string | boolean) => {
    setDefinition((current) => ({
      ...current,
      steps: current.steps.map((step, position) =>
        position === index
          ? { ...step, params: { ...step.params, [field.key]: coerceParam(field, raw) } }
          : step,
      ),
    }));
  };

  const addStep = (spec: ActionSpec) => {
    setDefinition((current) => ({
      ...current,
      steps: [...current.steps, blankStep(spec, current.steps.length + 1)],
    }));
  };

  const removeStep = (index: number) => {
    setDefinition((current) => ({
      ...current,
      steps: current.steps.filter((_, position) => position !== index),
    }));
  };

  const moveStep = (index: number, by: -1 | 1) => {
    setDefinition((current) => {
      const next = [...current.steps];
      const target = index + by;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return { ...current, steps: next };
    });
  };

  return (
    <form action={submit} className="flex flex-col gap-4" data-workflow-editor={workflowId}>
      <input type="hidden" name="workflowId" value={workflowId} />
      <input type="hidden" name="definition" value={JSON.stringify(cleanDefinition(definition))} />

      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p className="text-xs text-[var(--color-success)]" data-save-result>
          {state.message}
        </p>
      )}

      <Card title="What starts it" description="One thing happens, and this workflow begins.">
        <div className="flex flex-col gap-3">
          <Field
            label="When this happens"
            error={problemsAt(problems, 'definition.trigger.type')[0]?.message}
          >
            <select
              name="__trigger"
              value={definition.trigger.type}
              onChange={(event) => setTrigger(event.target.value)}
              disabled={readOnly}
              className={controlClassName}
              data-trigger-picker
            >
              <option value="">Choose what starts this workflow…</option>
              {catalogue.triggers.map((spec) => (
                <option key={spec.key} value={spec.key}>
                  {spec.label}
                </option>
              ))}
            </select>
          </Field>
          {triggerSpec && (
            <p className="text-xs text-[var(--color-text-muted)]" data-trigger-hint>
              {triggerSpec.hint}
            </p>
          )}
          {triggerSpec?.params.map((field) => (
            <ParamInput
              key={field.key}
              field={field}
              value={definition.trigger.params?.[field.key]}
              references={references}
              disabled={readOnly}
              error={problemsAt(problems, `definition.trigger.params.${field.key}`)[0]?.message}
              onChange={(raw) => setTriggerParam(field, raw)}
            />
          ))}
          {problemsAt(problems, 'definition.trigger')[0] && (
            <ErrorNotice>{problemsAt(problems, 'definition.trigger')[0]!.message}</ErrorNotice>
          )}
        </div>
      </Card>

      <Card
        title="What it does"
        description={`Up to ${catalogue.limits.maxSteps} steps, in order. Each one waits for the one before it.`}
      >
        <div className="flex flex-col gap-4">
          {definition.steps.length === 0 && (
            <p className="text-sm text-[var(--color-text-muted)]" data-no-steps>
              No steps yet — add the first one below.
            </p>
          )}
          {problemsAt(problems, 'definition.steps')[0] && (
            <ErrorNotice>{problemsAt(problems, 'definition.steps')[0]!.message}</ErrorNotice>
          )}
          {definition.steps.map((step, index) => (
            <StepCard
              key={step.id}
              step={step}
              index={index}
              total={definition.steps.length}
              catalogue={catalogue}
              references={references}
              problems={problems}
              disabled={readOnly}
              onParam={(field, raw) => setStepParam(index, field, raw)}
              onRemove={() => removeStep(index)}
              onMove={(by) => moveStep(index, by)}
            />
          ))}

          {!readOnly && (
            <div className="flex flex-wrap gap-2" data-add-step>
              {addable.map((spec) => (
                <Button
                  key={spec.key}
                  variant="secondary"
                  onClick={() => addStep(spec)}
                  disabled={definition.steps.length >= catalogue.limits.maxSteps}
                >
                  {`+ ${spec.label}`}
                </Button>
              ))}
            </div>
          )}
        </div>
      </Card>

      {!readOnly && (
        <div className="flex items-center gap-3">
          <Button type="submit" pending={pending}>
            {pending ? 'Saving…' : 'Save the draft'}
          </Button>
          <span className="text-xs text-[var(--color-text-muted)]">
            Saving does not change anything that is already running — publishing does.
          </span>
        </div>
      )}
    </form>
  );
}

function StepCard({
  step,
  index,
  total,
  catalogue,
  references,
  problems,
  disabled,
  onParam,
  onRemove,
  onMove,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  catalogue: AutomationCatalogue;
  references: ReferenceLists;
  problems: readonly DefinitionProblem[];
  disabled: boolean;
  onParam: (field: ParamField, raw: string | boolean) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const spec = catalogue.actions.find((entry) => entry.key === step.action);
  const path = `definition.steps[${index}]`;
  return (
    <div
      className="rounded-md border border-[var(--color-border)] p-3"
      data-step={step.id}
      data-step-action={step.action}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          {/* The step's name as text, not only inside its inputs: a settings list whose values
              live only in form controls is unreadable, and unassertable. */}
          <p className="text-sm font-medium" data-step-name>
            {`${index + 1}. ${spec?.label ?? step.action}`}
          </p>
          {spec && <p className="text-xs text-[var(--color-text-muted)]">{spec.hint}</p>}
        </div>
        {!disabled && (
          <div className="flex items-center gap-1">
            <Button variant="quiet" onClick={() => onMove(-1)} disabled={index === 0}>
              Up
            </Button>
            <Button variant="quiet" onClick={() => onMove(1)} disabled={index === total - 1}>
              Down
            </Button>
            <Button variant="quiet" onClick={onRemove}>
              Remove
            </Button>
          </div>
        )}
      </div>
      {spec === undefined ? (
        // An action the catalogue does not describe. It renders as a sentence rather than as
        // nothing: a step with no describer that draws an empty row is the timeline-registry
        // lesson, and the one thing a person must be able to do here is delete it.
        <p className="text-xs text-[var(--color-danger)]" data-step-unknown>
          {`This step is a “${step.action}”, which this workspace no longer offers. Remove it.`}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {spec.params.map((field) => (
            <ParamInput
              key={field.key}
              field={field}
              value={step.params?.[field.key]}
              references={references}
              disabled={disabled}
              error={problemsAt(problems, `${path}.params.${field.key}`)[0]?.message}
              onChange={(raw) => onParam(field, raw)}
            />
          ))}
          {problemsAt(problems, path)[0] && (
            <p className="text-xs text-[var(--color-danger)]">
              {problemsAt(problems, path)[0]!.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One parameter, rendered from its declaration.
 *
 * This function is the whole mechanism: there is a branch per **type**, not per action, so a new
 * action's fields are drawn by code that was written before it existed. A `reference` reads its
 * options from the lists the page fetched, which is why a workspace's own statuses appear in a
 * picker without this file — or the registry — naming one.
 */
function ParamInput({
  field,
  value,
  references,
  disabled,
  error,
  onChange,
}: {
  field: ParamField;
  value: unknown;
  references: ReferenceLists;
  disabled: boolean;
  error?: string;
  onChange: (raw: string | boolean) => void;
}) {
  const asText = value === undefined || value === null ? '' : String(value);
  const label = field.required ? field.label : `${field.label} (optional)`;
  const common = {
    disabled,
    className: `${controlClassName} w-full min-w-0`,
    'data-param': field.key,
  } as const;

  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          data-param={field.key}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{field.label}</span>
        {field.hint && <span className="text-xs text-[var(--color-text-muted)]">{field.hint}</span>}
      </label>
    );
  }

  if (field.type === 'textarea') {
    return (
      <Field label={label} hint={field.hint} error={error}>
        <textarea
          {...common}
          rows={3}
          value={asText}
          maxLength={field.max}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  }

  if (field.type === 'select' || field.type === 'reference') {
    const options =
      field.type === 'select' ? (field.options ?? []) : (references[field.reference ?? ''] ?? []);
    return (
      <Field label={label} hint={field.hint} error={error}>
        <select {...common} value={asText} onChange={(event) => onChange(event.target.value)}>
          <option value="">
            {field.type === 'reference' && options.length === 0
              ? 'Nothing to choose from yet'
              : 'Choose…'}
          </option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  return (
    <Field
      label={label}
      hint={field.type === 'duration' ? (field.hint ?? 'In minutes.') : field.hint}
      error={error}
    >
      <input
        {...common}
        type={field.type === 'number' || field.type === 'duration' ? 'number' : 'text'}
        value={asText}
        min={field.min}
        max={field.max}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
