'use client';

import { useActionState, useState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { convertLead } from '../actions';

function valueOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.values?.[key] : undefined;
}

/**
 * Turning a won lead into a customer (`FR-DEAL-4`).
 *
 * It asks for the billing details and nothing else, because everything else is already on the lead
 * — and it says so, because "convert" sounds destructive and the first question anybody has is
 * whether they are about to lose the history they have been building for six weeks.
 *
 * Closed by default: this is a one-way step, and a form that is already open invites a stray click.
 */
export function ConvertForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(convertLead, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <Button type="button" onClick={() => setOpen(true)}>
          Convert to customer
        </Button>
        <p className="text-xs text-[var(--color-text-muted)]">
          The lead stays where it is, marked won. Their whole history comes with them.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="leadId" value={leadId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      <Field
        label="Billing address"
        hint="Where the invoice goes. Optional — you can add it later."
      >
        <input
          name="billingLine1"
          defaultValue={valueOf(state, 'billingLine1')}
          className={controlClassName}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="City">
          <input name="city" defaultValue={valueOf(state, 'city')} className={controlClassName} />
        </Field>
        <Field label="Postal code">
          <input
            name="postalCode"
            defaultValue={valueOf(state, 'postalCode')}
            className={controlClassName}
          />
        </Field>
      </div>
      <Field label="GSTIN / tax id" hint="Stored as typed — formats differ by country.">
        <input name="taxId" defaultValue={valueOf(state, 'taxId')} className={controlClassName} />
      </Field>
      <Field label="Note" hint="Goes on the timeline, so “why did this convert” has an answer.">
        <input name="note" defaultValue={valueOf(state, 'note')} className={controlClassName} />
      </Field>

      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Converting…' : 'Convert to customer'}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-[var(--color-text-muted)] underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
