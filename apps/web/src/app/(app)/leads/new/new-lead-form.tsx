'use client';

import { useActionState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { createLead } from '../actions';

/**
 * The capture form.
 *
 * Field-level errors come back from the API's `details` array, so a refusal points at the input that
 * is wrong — "Not a phone number (too short)" under the phone box, rather than one sentence at the
 * top that leaves someone hunting.
 */
export function NewLeadForm({ sources }: { sources: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createLead, IDLE);
  const fieldError = (name: string) =>
    state.status === 'error' ? state.fieldErrors?.[name] : undefined;
  /**
   * What was typed, after a refusal.
   *
   * A server action re-renders the tree and remounts this form, so without this every box empties
   * on a validation error and eight fields have to be typed again.
   */
  const kept = (name: string) => (state.status === 'error' ? (state.values?.[name] ?? '') : '');

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" hint={fieldError('firstName')}>
          <input
            name="firstName"
            defaultValue={kept('firstName')}
            autoComplete="given-name"
            className={controlClassName}
            required
          />
        </Field>
        <Field label="Last name" hint={fieldError('lastName')}>
          <input
            name="lastName"
            defaultValue={kept('lastName')}
            autoComplete="family-name"
            className={controlClassName}
          />
        </Field>
        <Field
          label="Phone"
          hint={fieldError('phone') ?? 'With or without +91 — it is normalized on save.'}
        >
          <input
            name="phone"
            defaultValue={kept('phone')}
            inputMode="tel"
            autoComplete="tel"
            className={controlClassName}
          />
        </Field>
        <Field
          label="WhatsApp"
          hint={fieldError('whatsapp') ?? 'Leave blank if it is the same number.'}
        >
          <input
            name="whatsapp"
            defaultValue={kept('whatsapp')}
            inputMode="tel"
            className={controlClassName}
          />
        </Field>
        <Field label="Email" hint={fieldError('email')}>
          <input
            name="email"
            defaultValue={kept('email')}
            type="email"
            autoComplete="email"
            className={controlClassName}
          />
        </Field>
        <Field label="Company" hint={fieldError('company')}>
          <input name="company" defaultValue={kept('company')} className={controlClassName} />
        </Field>
        <Field label="City" hint={fieldError('city')}>
          <input
            name="city"
            defaultValue={kept('city')}
            autoComplete="address-level2"
            className={controlClassName}
          />
        </Field>
        <Field label="Priority">
          <select
            name="priority"
            defaultValue={kept('priority') || 'medium'}
            className={controlClassName}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
        <Field label="Source" hint="Where this enquiry came from.">
          <select
            name="leadSourceId"
            defaultValue={kept('leadSourceId')}
            className={controlClassName}
          >
            <option value="">Not sure</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Deal value" hint={fieldError('value') ?? 'Whole rupees. Optional.'}>
          <input
            name="value"
            defaultValue={kept('value')}
            inputMode="decimal"
            className={controlClassName}
          />
          <input type="hidden" name="currency" value="INR" />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Create lead'}
        </Button>
        <span className="text-xs text-[var(--color-text-muted)]">
          Assignment and scoring run automatically.
        </span>
      </div>
    </form>
  );
}
