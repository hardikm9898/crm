'use client';

import { useActionState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { uploadImport } from '../actions';

/**
 * Step one: the file.
 *
 * Nothing is imported here. The upload is read, its columns are matched against this workspace's
 * fields, and the proposal comes back for a person to confirm — which is what makes a wrong guess
 * harmless.
 */
export function UploadForm({ maxRows }: { maxRows: number }) {
  const [state, action, pending] = useActionState(uploadImport, IDLE);
  const fieldError = state.status === 'error' ? state.fieldErrors?.['file'] : undefined;

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Field
        label="CSV file"
        hint={
          fieldError ??
          `Up to ${maxRows.toLocaleString('en-IN')} rows. The first row must name the columns — “Name, Mobile No., E-mail ID” is read correctly.`
        }
      >
        <input
          type="file"
          name="file"
          accept=".csv,text/csv,application/vnd.ms-excel"
          required
          className={controlClassName}
        />
      </Field>
      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Reading the file…' : 'Read the file'}
        </Button>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        Nothing is imported yet. You will see the first few rows and which column we think is which,
        and can change any of it before anything is created.
      </p>
    </form>
  );
}
