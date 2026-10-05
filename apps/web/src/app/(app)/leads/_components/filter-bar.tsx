'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  OPERATOR_LABELS,
  describeCondition,
  encodeFilter,
  leadListHref,
  withoutCondition,
  type CatalogueField,
  type UiCondition,
} from '@/lib/lead-filters';
import { DATE_WINDOW_LABELS } from '@/lib/lead-filters';
import { Button } from '@/components/ui';

/**
 * The filter bar (`FR-VIEW-2`).
 *
 * Built entirely from the catalogue the API publishes — a field list, and per field the operators it
 * supports. Nothing about which fields exist is hardcoded here, so a custom field added a minute ago
 * is filterable without a deploy (rule 4).
 *
 * State lives in the URL, not in this component: adding a chip navigates. That keeps the list a
 * server component with one source of truth, makes a filtered list shareable, and means the back
 * button undoes a filter — which is what people expect it to do.
 */
export function FilterBar({
  fields,
  conditions,
  labels,
  options,
  sort,
  direction,
  view,
}: {
  fields: CatalogueField[];
  conditions: UiCondition[];
  labels: Record<string, string>;
  /** Choices for reference and enum fields, keyed by the field name. */
  options: Record<string, { value: string; label: string }[]>;
  sort: string | null;
  direction: string | null;
  view: string | null;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [field, setField] = useState<string>(fields[0]?.field ?? '');
  const [operator, setOperator] = useState<string>(fields[0]?.operators[0] ?? 'eq');
  const [value, setValue] = useState('');
  const [matchAny, setMatchAny] = useState(false);

  const definition = fields.find((entry) => entry.field === field);
  const takesNoValue = operator === 'is_null' || operator === 'is_not_null';
  const isList = ['in', 'nin', 'has_any', 'has_all'].includes(operator);
  const choices = options[field] ?? [];

  function go(next: UiCondition[]) {
    router.push(leadListHref({ view, conditions: next, sort, direction }));
  }

  function add() {
    if (!definition) return;
    if (!takesNoValue && value.trim() === '') return;
    // A new chip goes into its own OR group when "match any" is chosen, and into the first group
    // otherwise — which is the distinction between "Pune and urgent" and "Pune or urgent".
    const groupIndex = matchAny ? Math.max(0, ...conditions.map((c) => c.groupIndex)) + 1 : 0;
    const parsed: UiCondition = {
      field,
      operator,
      groupIndex,
      ...(takesNoValue
        ? {}
        : {
            value: isList
              ? value
                  .split(',')
                  .map((entry) => entry.trim())
                  .filter(Boolean)
              : value.trim(),
          }),
    };
    setValue('');
    setAdding(false);
    go([...conditions, parsed]);
  }

  const groups = [...new Set(conditions.map((condition) => condition.groupIndex))].sort(
    (left, right) => left - right,
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {conditions.length === 0 && (
          <span className="text-sm text-[var(--color-text-muted)]">No filters</span>
        )}
        {groups.map((group, groupPosition) => (
          <span key={group} className="flex flex-wrap items-center gap-2">
            {groupPosition > 0 && (
              <span className="text-xs font-medium uppercase text-[var(--color-text-muted)]">
                or
              </span>
            )}
            {conditions
              .map((condition, index) => ({ condition, index }))
              .filter((entry) => entry.condition.groupIndex === group)
              .map((entry, position) => (
                <span key={entry.index} className="flex items-center gap-2">
                  {position > 0 && (
                    <span className="text-xs font-medium uppercase text-[var(--color-text-muted)]">
                      and
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-xs">
                    {describeCondition(
                      entry.condition,
                      fields.find((f) => f.field === entry.condition.field),
                      labels,
                    )}
                    <button
                      type="button"
                      onClick={() => go(withoutCondition(conditions, entry.index))}
                      aria-label={`Remove filter: ${describeCondition(
                        entry.condition,
                        fields.find((f) => f.field === entry.condition.field),
                        labels,
                      )}`}
                      className="ml-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    >
                      ×
                    </button>
                  </span>
                </span>
              ))}
          </span>
        ))}

        {!adding && (
          <Button variant="quiet" onClick={() => setAdding(true)}>
            + Add filter
          </Button>
        )}
        {conditions.length > 0 && (
          <Button variant="quiet" onClick={() => go([])}>
            Clear
          </Button>
        )}
      </div>

      {adding && (
        <div className="flex flex-wrap items-end gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Field</span>
            <select
              value={field}
              onChange={(event) => {
                const next = event.target.value;
                setField(next);
                const nextField = fields.find((entry) => entry.field === next);
                setOperator(nextField?.operators[0] ?? 'eq');
                setValue('');
              }}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            >
              {fields.map((entry) => (
                <option key={entry.field} value={entry.field}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium">Condition</span>
            <select
              value={operator}
              onChange={(event) => setOperator(event.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            >
              {(definition?.operators ?? []).map((entry) => (
                <option key={entry} value={entry}>
                  {OPERATOR_LABELS[entry] ?? entry}
                </option>
              ))}
            </select>
          </label>

          {!takesNoValue && (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Value</span>
              {choices.length > 0 ? (
                <select
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                >
                  <option value="">Choose…</option>
                  {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              ) : definition?.kind === 'date' ? (
                <select
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                >
                  <option value="">Choose…</option>
                  {Object.entries(DATE_WINDOW_LABELS).map(([window, label]) => (
                    <option key={window} value={`@${window}`}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={
                    isList
                      ? 'Comma-separated'
                      : definition?.valueUnit === 'minor'
                        ? 'In paise (₹1 = 100)'
                        : ''
                  }
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
                />
              )}
              {definition?.describe && (
                <span className="max-w-xs text-[var(--color-text-muted)]">
                  {definition.describe}
                </span>
              )}
            </label>
          )}

          <label className="flex items-center gap-1.5 pb-2 text-xs text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={matchAny}
              onChange={(event) => setMatchAny(event.target.checked)}
            />
            Match any (or)
          </label>

          <div className="flex gap-2 pb-1">
            <Button onClick={add}>Apply</Button>
            <Button variant="quiet" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Used by the view switcher to tell whether the URL still matches the view it came from. */
export function filtersMatch(left: readonly UiCondition[], right: readonly UiCondition[]): boolean {
  return encodeFilter(left) === encodeFilter(right);
}
