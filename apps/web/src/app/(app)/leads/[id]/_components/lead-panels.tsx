'use client';

import { useActionState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { addTouchpoint, deleteLead, dismissDuplicate, updateLead } from '../actions';
import type { LeadDetail, Option } from '@/lib/leads';

/** Editing the lead's own fields. Separate from the transitions, which are endpoints of their own. */
export function EditLeadForm({ lead }: { lead: LeadDetail }) {
  const [state, action, pending] = useActionState(updateLead, IDLE);
  const fieldError = (name: string) =>
    state.status === 'error' ? state.fieldErrors?.[name] : undefined;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="leadId" value={lead.id} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" hint={fieldError('firstName')}>
          <input
            name="firstName"
            defaultValue={lead.firstName ?? ''}
            className={controlClassName}
          />
        </Field>
        <Field label="Last name" hint={fieldError('lastName')}>
          <input name="lastName" defaultValue={lead.lastName ?? ''} className={controlClassName} />
        </Field>
        <Field label="Phone" hint={fieldError('phone')}>
          <input
            name="phone"
            defaultValue={lead.phone ?? ''}
            inputMode="tel"
            className={controlClassName}
          />
        </Field>
        <Field label="WhatsApp" hint={fieldError('whatsapp')}>
          <input
            name="whatsapp"
            defaultValue={lead.whatsapp ?? ''}
            inputMode="tel"
            className={controlClassName}
          />
        </Field>
        <Field label="Email" hint={fieldError('email')}>
          <input
            name="email"
            type="email"
            defaultValue={lead.email ?? ''}
            className={controlClassName}
          />
        </Field>
        <Field label="Company" hint={fieldError('company')}>
          <input name="company" defaultValue={lead.company ?? ''} className={controlClassName} />
        </Field>
        <Field label="Job title">
          <input name="jobTitle" defaultValue={lead.jobTitle ?? ''} className={controlClassName} />
        </Field>
        <Field label="City">
          <input name="city" defaultValue={lead.city ?? ''} className={controlClassName} />
        </Field>
        <Field label="State">
          <input name="state" defaultValue={lead.state ?? ''} className={controlClassName} />
        </Field>
        <Field label="Postal code">
          <input
            name="postalCode"
            defaultValue={lead.postalCode ?? ''}
            className={controlClassName}
          />
        </Field>
        <Field label="Priority">
          <select name="priority" defaultValue={lead.priority} className={controlClassName}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
        <Field
          label="Deal value"
          hint={fieldError('value') ?? 'Whole rupees. Clear the box to remove it.'}
        >
          <input
            name="value"
            inputMode="decimal"
            defaultValue={lead.valueMinor === null ? '' : String(lead.valueMinor / 100)}
            className={controlClassName}
          />
          <input type="hidden" name="currency" value={lead.currency ?? 'INR'} />
        </Field>
      </div>

      <div>
        <Button type="submit" pending={pending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

/** Recording that this lead got in touch again — the attribution spine, by hand. */
export function TouchpointForm({ leadId, sources }: { leadId: string; sources: Option[] }) {
  const [state, action, pending] = useActionState(addTouchpoint, IDLE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Channel</span>
        <select name="channel" defaultValue="manual" className={controlClassName}>
          {[
            'manual',
            'form',
            'whatsapp',
            'call',
            'email',
            'walk_in',
            'referral',
            'meta_ads',
            'google_ads',
          ].map((channel) => (
            <option key={channel} value={channel}>
              {channel.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Source</span>
        <select name="leadSourceId" defaultValue="" className={controlClassName}>
          <option value="">Same as before</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="secondary" pending={pending}>
        Record enquiry
      </Button>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {state.message}
        </p>
      )}
    </form>
  );
}

/**
 * Deleting a lead.
 *
 * Two steps, because it is destructive enough to want a confirmation (rule 14) — and the copy says
 * what actually happens, which is a recycle bin rather than destruction.
 */
export function DeleteLeadButton({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(deleteLead, IDLE);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-[var(--color-danger)]">Delete this lead</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="leadId" value={leadId} />
        <p className="text-xs text-[var(--color-text-muted)]">
          It moves to the recycle bin with its whole history and can be restored. Nothing is
          destroyed.
        </p>
        <div>
          <Button type="submit" variant="danger" pending={pending}>
            Yes, move to recycle bin
          </Button>
        </div>
        {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      </form>
    </details>
  );
}

/**
 * The duplicate warning banner.
 *
 * Shown when the API has flagged this lead as a possible duplicate of another. Dismissing records
 * "different people" so the pair is never raised again — the decision is kept, not just hidden.
 */
export function DuplicateBanner({
  leadId,
  pairs,
}: {
  leadId: string;
  pairs: { id: string; otherId: string | null; otherName: string; confidence: number }[];
}) {
  const [state, action, pending] = useActionState(dismissDuplicate, IDLE);
  if (pairs.length === 0) return null;

  return (
    <div
      role="alert"
      className="rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-3"
    >
      <p className="text-sm font-medium">This may be a duplicate</p>
      <ul className="mt-1 flex flex-col gap-2">
        {pairs.map((pair) => (
          <li key={pair.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              Looks like <strong>{pair.otherName}</strong> ({pair.confidence}% confident)
            </span>
            {pair.otherId && (
              <a
                href={`/leads/${pair.otherId}`}
                className="text-[var(--color-primary)] hover:underline"
              >
                Open it
              </a>
            )}
            <form action={action}>
              <input type="hidden" name="pairId" value={pair.id} />
              <input type="hidden" name="leadId" value={leadId} />
              <Button type="submit" variant="quiet" pending={pending}>
                Different people
              </Button>
            </form>
          </li>
        ))}
      </ul>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
    </div>
  );
}
