'use client';

import { useActionState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { createCustomer, deleteCustomer, restoreCustomer, updateCustomer } from '../actions';

/** A refused submission comes back with what was typed, never empty. */
function valueOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.values?.[key] : undefined;
}

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

/** Somebody who was never a lead: a walk-in, or a book of business being migrated. */
export function NewCustomerForm() {
  const [state, action, pending] = useActionState(createCustomer, IDLE);

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" hint={errorOf(state, 'firstName')}>
          <input
            name="firstName"
            defaultValue={valueOf(state, 'firstName')}
            className={controlClassName}
          />
        </Field>
        <Field label="Last name" hint={errorOf(state, 'lastName')}>
          <input
            name="lastName"
            defaultValue={valueOf(state, 'lastName')}
            className={controlClassName}
          />
        </Field>
        <Field label="Company" hint={errorOf(state, 'company')}>
          <input
            name="company"
            defaultValue={valueOf(state, 'company')}
            className={controlClassName}
          />
        </Field>
        <Field label="Job title" hint={errorOf(state, 'jobTitle')}>
          <input
            name="jobTitle"
            defaultValue={valueOf(state, 'jobTitle')}
            className={controlClassName}
          />
        </Field>
        <Field label="Phone" hint={errorOf(state, 'phone')}>
          <input name="phone" defaultValue={valueOf(state, 'phone')} className={controlClassName} />
        </Field>
        <Field label="Email" hint={errorOf(state, 'email')}>
          <input
            type="email"
            name="email"
            defaultValue={valueOf(state, 'email')}
            className={controlClassName}
          />
        </Field>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-medium">Where the invoice goes</legend>
        <Field label="Address" hint={errorOf(state, 'billingLine1')}>
          <input
            name="billingLine1"
            defaultValue={valueOf(state, 'billingLine1')}
            className={controlClassName}
          />
        </Field>
        <Field label="City" hint={errorOf(state, 'city')}>
          <input name="city" defaultValue={valueOf(state, 'city')} className={controlClassName} />
        </Field>
        <Field label="Postal code" hint={errorOf(state, 'postalCode')}>
          <input
            name="postalCode"
            defaultValue={valueOf(state, 'postalCode')}
            className={controlClassName}
          />
        </Field>
        <Field
          label="GSTIN / tax id"
          hint={errorOf(state, 'taxId') ?? 'Stored as typed — formats differ by country.'}
        >
          <input name="taxId" defaultValue={valueOf(state, 'taxId')} className={controlClassName} />
        </Field>
      </fieldset>

      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Creating…' : 'Create customer'}
        </Button>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        Give at least a name, a company, a phone number or an email address — enough to find them
        again.
      </p>
    </form>
  );
}

/** Editing the account. Blank means "clear this", which is how a wrong tax id gets removed. */
export function CustomerDetailsForm({
  id,
  initial,
}: {
  id: string;
  initial: Record<string, string>;
}) {
  const [state, action, pending] = useActionState(updateCustomer, IDLE);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={id} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ['firstName', 'First name'],
            ['lastName', 'Last name'],
            ['company', 'Company'],
            ['jobTitle', 'Job title'],
            ['phone', 'Phone'],
            ['email', 'Email'],
            ['billingLine1', 'Address'],
            ['city', 'City'],
            ['state', 'State'],
            ['postalCode', 'Postal code'],
            ['country', 'Country code'],
            ['taxId', 'GSTIN / tax id'],
          ] as const
        ).map(([name, label]) => (
          <Field key={name} label={label} hint={errorOf(state, name)}>
            <input
              name={name}
              defaultValue={valueOf(state, name) ?? initial[name] ?? ''}
              className={controlClassName}
            />
          </Field>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}

export function DeleteCustomerButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(deleteCustomer, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="quiet" pending={pending}>
        {pending ? 'Deleting…' : 'Delete customer'}
      </Button>
    </form>
  );
}

export function RestoreCustomerButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(restoreCustomer, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" pending={pending}>
        {pending ? 'Restoring…' : 'Restore customer'}
      </Button>
    </form>
  );
}
