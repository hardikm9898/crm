'use client';

import { useActionState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Button, ErrorNotice, controlClassName } from '@/components/ui';
import { saveMapping } from '../actions';

export interface ImportableField {
  field: string;
  label: string;
  describe?: string;
  required?: boolean;
}

export interface ImportMode {
  mode: string;
  label: string;
  describe: string;
}

/**
 * Step two: which column is which, and what to do about people already in the workspace.
 *
 * The selects start on the proposal, so the common case is reading it and pressing Continue. Each
 * column shows a sample value underneath, because "Column C" means nothing and “9876543210” means
 * everything.
 */
export function MappingForm({
  jobId,
  header,
  sample,
  mapping,
  fields,
  modes,
  mode,
}: {
  jobId: string;
  header: string[];
  sample: Record<string, string>[];
  mapping: Record<string, string>;
  fields: ImportableField[];
  modes: ImportMode[];
  mode: string;
}) {
  const [state, action, pending] = useActionState(saveMapping, IDLE);

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="jobId" value={jobId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="py-2 pr-4 font-medium">Column in your file</th>
              <th className="py-2 pr-4 font-medium">Example</th>
              <th className="py-2 font-medium">Import as</th>
            </tr>
          </thead>
          <tbody>
            {header.map((column) => (
              <tr key={column} className="border-b border-[var(--color-border)]/60 align-top">
                <td className="py-2 pr-4 font-medium">{column}</td>
                <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                  {sample.map((row) => row[column]).find((value) => value && value !== '') ?? '—'}
                </td>
                <td className="py-2">
                  <select
                    name={`column:${column}`}
                    defaultValue={mapping[column] ?? '-'}
                    className={controlClassName}
                  >
                    <option value="-">Do not import</option>
                    {fields.map((field) => (
                      <option key={field.field} value={field.field}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">
          If somebody in this file is already a lead
        </legend>
        {modes.map((option) => (
          <label key={option.mode} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="mode"
              value={option.mode}
              defaultChecked={option.mode === mode}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-[var(--color-text-muted)]">{option.describe}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save mapping'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}
