'use client';

import { useActionState, useState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { rupees } from '@/lib/line-items-form';
import type { PaymentMethod, PaymentSummary } from '@/lib/payments';
import {
  confirmPayment,
  correctPayment,
  createPaymentMethod,
  deletePayment,
  deletePaymentMethod,
  failPayment,
  recordPayment,
  refundPayment,
  updatePaymentMethod,
} from '../actions';

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

/**
 * Recording money that arrived.
 *
 * The method dropdown decides whether the reference box is required, because the tenant said so on
 * the method — a UPI payment with no transaction id cannot be reconciled, and the API refuses it.
 * Showing that before the submission is the difference between a form and an argument.
 */
export function RecordPaymentForm({
  methods,
  dealId,
  quotationId,
  leadId,
  customerId,
  outstandingMinor,
  currency,
}: {
  methods: PaymentMethod[];
  dealId?: string;
  quotationId?: string;
  leadId?: string;
  customerId?: string;
  outstandingMinor?: number;
  currency: string;
}) {
  const [state, action, pending] = useActionState(recordPayment, IDLE);
  /**
   * Controlled, and **seeded from the echoed submission** rather than from `''`.
   *
   * `useState('')` lost the method somebody had picked the moment a refusal re-rendered the form —
   * and because the method is what decides whether a reference is required, the commonest path
   * through this form (pick Cheque → refused for the missing reference → type the number → submit)
   * then recorded the payment with **no method at all**, silently. A `<select>` needs the echo
   * explicitly: `state.values` restores the text boxes through `defaultValue`, and nothing restores
   * a select's React state unless it is initialised from the same place.
   */
  const submittedMethodId = state.status === 'error' ? (state.values?.['methodId'] ?? '') : '';
  const [methodId, setMethodId] = useState(submittedMethodId);
  const selected = methods.find((method) => method.id === (methodId || submittedMethodId));

  return (
    <form action={action} className="flex flex-col gap-3">
      {dealId && <input type="hidden" name="dealId" value={dealId} />}
      {quotationId && <input type="hidden" name="quotationId" value={quotationId} />}
      {leadId && <input type="hidden" name="leadId" value={leadId} />}
      {customerId && <input type="hidden" name="customerId" value={customerId} />}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={`Amount (${currency})`}
          {...(outstandingMinor !== undefined && outstandingMinor > 0
            ? { hint: `${rupees(outstandingMinor)} still outstanding` }
            : {})}
          {...(errorOf(state, 'amount') ? { error: errorOf(state, 'amount') } : {})}
        >
          <input
            name="amount"
            className={controlClassName}
            defaultValue={valueOf(
              state,
              'amount',
              outstandingMinor && outstandingMinor > 0 ? rupees(outstandingMinor) : '',
            )}
            placeholder="50000"
          />
        </Field>
        <Field label="How did it arrive?">
          {/*
            `key` is the echoed value, and the select is uncontrolled underneath it.
            A controlled `<select value>` did not take: React re-created the options in the same
            commit as the new value, and the DOM kept `selectedIndex: 0` — so the screen said
            "Not recorded" while the component thought Cheque was chosen, which is the worst of
            both. Re-keying on the echo remounts the select exactly when the echo changes (a
            refusal), so `defaultValue` applies; while somebody is typing the key is stable and
            their own choice stands.
          */}
          <select
            key={`method-${submittedMethodId}`}
            name="methodId"
            defaultValue={submittedMethodId}
            onChange={(event) => setMethodId(event.target.value)}
            className={controlClassName}
          >
            <option value="">Not recorded</option>
            {methods
              .filter((method) => method.isActive)
              .map((method) => (
                <option key={method.id} value={method.id}>
                  {method.name}
                </option>
              ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={selected?.requiresReference ? 'Reference (required)' : 'Reference'}
          hint={
            selected?.requiresReference
              ? `${selected.name} payments need a transaction id or cheque number.`
              : 'A cheque number or transaction id, if there is one.'
          }
          {...(errorOf(state, 'reference') ? { error: errorOf(state, 'reference') } : {})}
        >
          <input
            name="reference"
            className={controlClassName}
            defaultValue={valueOf(state, 'reference', '')}
          />
        </Field>
        <Field label="Received on" hint="Backdating is fine — the statement follows the cheque.">
          <input
            name="paidAt"
            type="date"
            className={controlClassName}
            defaultValue={valueOf(state, 'paidAt', '')}
          />
        </Field>
      </div>

      <Field label="Status">
        <select name="status" className={controlClassName} defaultValue="succeeded">
          <option value="succeeded">The money has arrived</option>
          <option value="pending">Recorded, not cleared yet</option>
        </select>
      </Field>

      <Field label="Note">
        <input
          name="note"
          className={controlClassName}
          defaultValue={valueOf(state, 'note', '')}
          placeholder="Collected at the site visit"
        />
      </Field>

      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Recording…' : 'Record the payment'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}

/** Confirm, fail or refund — whichever the payment's status allows. */
export function PaymentOutcomeForms({ payment }: { payment: PaymentSummary }) {
  const [confirmState, confirmAction, confirming] = useActionState(confirmPayment, IDLE);
  const [failState, failAction, failing] = useActionState(failPayment, IDLE);
  const [refundState, refundAction, refunding] = useActionState(refundPayment, IDLE);

  return (
    <div className="flex flex-col gap-4">
      {payment.status === 'pending' && (
        <>
          <form action={confirmAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={payment.id} />
            <Button type="submit" pending={confirming}>
              {confirming ? 'Confirming…' : 'It cleared'}
            </Button>
            {confirmState.status === 'error' && <ErrorNotice>{confirmState.message}</ErrorNotice>}
          </form>
          <form action={failAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={payment.id} />
            <input
              name="note"
              className={controlClassName}
              placeholder="Returned unpaid"
              aria-label="Why it failed"
            />
            <Button type="submit" variant="secondary" pending={failing}>
              {failing ? 'Recording…' : 'It did not clear'}
            </Button>
            {failState.status === 'error' && <ErrorNotice>{failState.message}</ErrorNotice>}
          </form>
        </>
      )}

      {payment.status === 'succeeded' && (
        <form action={refundAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={payment.id} />
          <input
            name="note"
            className={controlClassName}
            placeholder="Customer cancelled"
            aria-label="Why it was refunded"
          />
          <Button type="submit" variant="secondary" pending={refunding}>
            {refunding ? 'Recording…' : 'Refund it'}
          </Button>
          <p className="text-xs text-[var(--color-text-muted)]">
            The receipt stays on the record; the money leaves every total.
          </p>
          {refundState.status === 'error' && <ErrorNotice>{refundState.message}</ErrorNotice>}
        </form>
      )}

      {(payment.status === 'failed' || payment.status === 'refunded') && (
        <p className="text-sm text-[var(--color-text-muted)]">
          Nothing more to do here. Record a new payment if money arrives again.
        </p>
      )}
    </div>
  );
}

/** Correcting a figure somebody typed wrong, without losing the receipt number. */
export function CorrectPaymentForm({
  payment,
  methods,
}: {
  payment: PaymentSummary;
  methods: PaymentMethod[];
}) {
  const [state, action, pending] = useActionState(correctPayment, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={payment.id} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label={`Amount (${payment.currency})`}
          {...(errorOf(state, 'amount') ? { error: errorOf(state, 'amount') } : {})}
        >
          <input
            name="amount"
            className={controlClassName}
            defaultValue={valueOf(state, 'amount', rupees(payment.amountMinor))}
          />
        </Field>
        <Field label="Method">
          <select
            name="methodId"
            className={controlClassName}
            defaultValue={payment.methodId ?? ''}
          >
            <option value="">Not recorded</option>
            {methods.map((method) => (
              <option key={method.id} value={method.id}>
                {method.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Reference"
          {...(errorOf(state, 'reference') ? { error: errorOf(state, 'reference') } : {})}
        >
          <input
            name="reference"
            className={controlClassName}
            defaultValue={valueOf(state, 'reference', payment.reference ?? '')}
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Correct it'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}

export function DeletePaymentButton({ paymentId }: { paymentId: string }) {
  const [state, action, pending] = useActionState(deletePayment, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={paymentId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="danger" pending={pending}>
        {pending ? 'Deleting…' : 'Delete this payment'}
      </Button>
    </form>
  );
}

// ── The methods a workspace accepts ─────────────────────────────────────────

export function NewPaymentMethodForm() {
  const [state, action, pending] = useActionState(createPaymentMethod, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" {...(errorOf(state, 'name') ? { error: errorOf(state, 'name') } : {})}>
          <input
            name="name"
            className={controlClassName}
            defaultValue={valueOf(state, 'name', '')}
            placeholder="NEFT"
          />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" name="requiresReference" />
          Needs a reference (a cheque number or transaction id)
        </label>
      </div>
      <Button type="submit" pending={pending}>
        {pending ? 'Adding…' : 'Add method'}
      </Button>
    </form>
  );
}

export function PaymentMethodRow({ method }: { method: PaymentMethod }) {
  const [saveState, saveAction, saving] = useActionState(updatePaymentMethod, IDLE);
  const [deleteState, deleteAction, deleting] = useActionState(deletePaymentMethod, IDLE);
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--color-border)]/60 py-3">
      {/*
        The name as **text**, not only as the value of an input.
        A list of seven editable rows reads as seven identical "Name" labels, and somebody scanning
        for "Cheque" cannot find it — a settings list has to be readable before it is editable.
      */}
      <p className="flex items-center gap-2 text-sm font-medium">
        <span data-method-name>{method.name}</span>
        {!method.isActive && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-700">
            not offered
          </span>
        )}
        {method.requiresReference && (
          <span className="text-xs font-normal text-[var(--color-text-muted)]">
            needs a reference
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <form action={saveAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={method.id} />
          <Field label="Name">
            <input name="name" className={controlClassName} defaultValue={method.name} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              name="requiresReference"
              defaultChecked={method.requiresReference}
            />
            Needs a reference
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="isActive" defaultChecked={method.isActive} />
            Offered on the form
          </label>
          <Button type="submit" variant="secondary" pending={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        <form action={deleteAction}>
          <input type="hidden" name="id" value={method.id} />
          <Button type="submit" variant="quiet" pending={deleting}>
            {deleting ? 'Removing…' : 'Remove'}
          </Button>
        </form>
      </div>
      {saveState.status === 'error' && <ErrorNotice>{saveState.message}</ErrorNotice>}
      {deleteState.status === 'error' && <ErrorNotice>{deleteState.message}</ErrorNotice>}
      {saveState.status === 'success' && (
        <span className="text-sm text-[var(--color-text-muted)]">{saveState.message}</span>
      )}
    </div>
  );
}
