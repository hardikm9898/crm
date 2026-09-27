'use client';

import { useActionState } from 'react';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { updateOrganization } from './actions';

/**
 * The workspace profile form.
 *
 * Timezone and currency are free text rather than a curated list: the platform is multi-country by
 * design, and a hardcoded dropdown is exactly the kind of assumption rule 4 forbids. The API
 * validates them, and its field errors are rendered inline.
 */
export function OrganizationForm({
  organization,
  editable,
}: {
  organization: {
    name: string;
    legalName: string | null;
    industry: string | null;
    timezone: string;
    defaultCurrency: string;
    defaultPhoneCountry: string;
  };
  editable: boolean;
}) {
  const [state, submit, pending] = useActionState(updateOrganization, IDLE);
  const fieldError = (field: string): string | undefined =>
    state.status === 'error' ? state.fieldErrors?.[field] : undefined;

  return (
    <form action={submit} className="flex flex-col gap-4">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Workspace name" hint={fieldError('name')}>
          <input
            name="name"
            defaultValue={organization.name}
            required
            disabled={!editable}
            className={controlClassName}
          />
        </Field>
        <Field label="Registered name" hint={fieldError('legalName') ?? 'Used on invoices.'}>
          <input
            name="legalName"
            defaultValue={organization.legalName ?? ''}
            disabled={!editable}
            className={controlClassName}
          />
        </Field>
        <Field label="Industry" hint={fieldError('industry')}>
          <input
            name="industry"
            defaultValue={organization.industry ?? ''}
            disabled={!editable}
            className={controlClassName}
          />
        </Field>
        <Field
          label="Timezone"
          hint={fieldError('timezone') ?? 'An IANA name, for example Asia/Kolkata.'}
        >
          <input
            name="timezone"
            defaultValue={organization.timezone}
            disabled={!editable}
            className={controlClassName}
          />
        </Field>
        <Field label="Currency" hint={fieldError('defaultCurrency') ?? 'A three-letter code.'}>
          <input
            name="defaultCurrency"
            defaultValue={organization.defaultCurrency}
            disabled={!editable}
            className={`${controlClassName} uppercase`}
          />
        </Field>
        <Field
          label="Phone country"
          hint={
            fieldError('defaultPhoneCountry') ??
            'Used when someone types a local number without a country code.'
          }
        >
          <input
            name="defaultPhoneCountry"
            defaultValue={organization.defaultPhoneCountry}
            disabled={!editable}
            className={`${controlClassName} uppercase`}
          />
        </Field>
      </div>

      {editable && (
        <div className="flex justify-end">
          <Button type="submit" pending={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}
    </form>
  );
}
