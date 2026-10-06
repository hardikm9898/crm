'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorNotice } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import type { IndustryTemplateOption } from '@/lib/industry-templates';
import { applyIndustryTemplate } from './actions';

/**
 * Choosing an industry (`FR-ONB-2`).
 *
 * Two things this screen has to be honest about, because applying a template **replaces** a
 * workspace's vocabulary:
 *
 *  * **What changes.** Each card says how many statuses, stages and sources it installs and names
 *    the questions it adds, so somebody can tell the difference between the ten rather than picking
 *    the one whose name they recognise.
 *  * **That it replaces.** The warning is on the button, not in a footnote. The API refuses once the
 *    workspace has records, so the destructive version of this is already impossible — but a person
 *    about to lose a status they renamed should be told before they click, not after.
 */
export function IndustryPicker({ templates }: { templates: IndustryTemplateOption[] }) {
  const [state, action, pending] = useActionState(applyIndustryTemplate, IDLE);
  const alreadyApplied = templates.find((template) => template.applied);
  const [chosen, setChosen] = useState(alreadyApplied?.key ?? '');
  const selected = templates.find((template) => template.key === chosen);

  if (templates.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        No industry templates are available. Set your statuses, stages and fields up in Settings
        instead — nothing here is required.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}

      <input type="hidden" name="key" value={chosen} />

      <div className="grid gap-3 sm:grid-cols-2">
        {templates.map((template) => (
          <label
            key={template.key}
            data-industry={template.key}
            className={`flex cursor-pointer flex-col gap-1 rounded-[var(--radius-card)] border p-3 text-left ${
              chosen === template.key
                ? 'border-[var(--color-accent)] bg-[var(--color-surface-raised)]'
                : 'border-[var(--color-border)]'
            }`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name="industry-choice"
                value={template.key}
                checked={chosen === template.key}
                onChange={() => setChosen(template.key)}
              />
              <span className="text-sm font-medium">{template.name}</span>
              {template.applied && (
                <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
                  in use
                </span>
              )}
            </span>
            <span className="text-sm text-[var(--color-text-muted)]">{template.description}</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              {template.statuses} statuses · {template.stages} stages · {template.sources} sources ·{' '}
              {template.fields} questions
            </span>
          </label>
        ))}
      </div>

      {selected && (
        <div className="rounded border border-[var(--color-border)] p-3 text-sm">
          <p className="font-medium">{selected.name} adds these questions to a lead</p>
          <p className="mt-1 text-[var(--color-text-muted)]" data-field-labels>
            {selected.fieldLabels.length > 0 ? selected.fieldLabels.join(' · ') : 'None'}
          </p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            This <strong>replaces</strong> your statuses, stages, sources, lost reasons, tags and
            lead questions with {selected.name}’s. Everything it writes is an ordinary row you can
            rename or remove afterwards, and it can only be applied while the workspace has no
            records yet.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" pending={pending} disabled={chosen === ''}>
          {pending ? 'Setting up…' : selected ? `Set up ${selected.name}` : 'Choose an industry'}
        </Button>
        <span className="text-xs text-[var(--color-text-muted)]">
          Skipping this is fine — the generic vocabulary works, and everything is editable.
        </span>
      </div>
    </form>
  );
}
