'use client';

import { useActionState, useState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import type { Product } from '@/lib/deals';
import type { QuotationLine } from '@/lib/quotations';
import { rupees } from '@/lib/line-items-form';
import {
  acceptQuotation,
  createQuotation,
  deleteQuotation,
  rejectQuotation,
  reviseQuotation,
  sendQuotation,
  setQuotationItems,
  updateNumberSeries,
  updateQuotation,
} from '../actions';

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

function valueOf(state: ActionState, key: string, fallback: string): string {
  return state.status === 'error' ? (state.values?.[key] ?? fallback) : fallback;
}

interface LineRow {
  key: string;
  productId: string;
  name: string;
  quantity: string;
  price: string;
  discount: string;
  tax: string;
}

const emptyRow = (index: number): LineRow => ({
  key: `new-${index}-${Date.now()}`,
  productId: '',
  name: '',
  quantity: '1',
  price: '',
  discount: '',
  tax: '',
});

/**
 * The line table, shared by "raise a quotation" and "edit the draft".
 *
 * Deliberately the same shape as the deal editor's, down to the field names, because the server
 * action that reads it is the same function. A second table with its own names would be a second
 * parser within a week.
 */
function LineTable({
  rows,
  setRows,
  products,
  currency,
  state,
}: {
  rows: LineRow[];
  setRows: React.Dispatch<React.SetStateAction<LineRow[]>>;
  products: Product[];
  currency: string;
  state: ActionState;
}) {
  const update = (index: number, patch: Partial<LineRow>) =>
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );

  const pickProduct = (index: number, productId: string) => {
    const product = products.find((candidate) => candidate.id === productId);
    update(index, {
      productId,
      // Filled from the catalogue, then editable: the agreed price is often not the list price.
      ...(product
        ? { name: product.name, price: rupees(product.priceMinor), tax: String(product.taxPercent) }
        : {}),
    });
  };

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="py-2 pr-3 font-medium">Product</th>
              <th className="py-2 pr-3 font-medium">Line</th>
              <th className="py-2 pr-3 font-medium">Qty</th>
              <th className="py-2 pr-3 font-medium">Price ({currency})</th>
              <th className="py-2 pr-3 font-medium">Discount</th>
              <th className="py-2 pr-3 font-medium">Tax %</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key} className="border-b border-[var(--color-border)]/60">
                <td className="py-2 pr-3">
                  <select
                    name="line-productId"
                    value={row.productId}
                    onChange={(event) => pickProduct(index, event.target.value)}
                    className={controlClassName}
                    aria-label={`Product for line ${index + 1}`}
                  >
                    <option value="">Typed by hand</option>
                    {products
                      .filter((product) => product.isActive || product.id === row.productId)
                      .map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name}
                        </option>
                      ))}
                  </select>
                </td>
                <td className="py-2 pr-3">
                  <input
                    name="line-name"
                    value={row.name}
                    onChange={(event) => update(index, { name: event.target.value })}
                    placeholder="What is on this line"
                    className={controlClassName}
                    aria-label={`Description for line ${index + 1}`}
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    name="line-quantity"
                    value={row.quantity}
                    onChange={(event) => update(index, { quantity: event.target.value })}
                    className={`${controlClassName} w-20`}
                    aria-label={`Quantity for line ${index + 1}`}
                  />
                  {errorOf(state, `line-quantity-${index}`) && (
                    <span className="mt-1 block text-xs text-[var(--color-danger)]">
                      {errorOf(state, `line-quantity-${index}`)}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <input
                    name="line-price"
                    value={row.price}
                    onChange={(event) => update(index, { price: event.target.value })}
                    className={`${controlClassName} w-28`}
                    aria-label={`Price for line ${index + 1}`}
                  />
                  {errorOf(state, `line-price-${index}`) && (
                    <span className="mt-1 block text-xs text-[var(--color-danger)]">
                      {errorOf(state, `line-price-${index}`)}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <input
                    name="line-discount"
                    value={row.discount}
                    onChange={(event) => update(index, { discount: event.target.value })}
                    className={`${controlClassName} w-24`}
                    aria-label={`Discount for line ${index + 1}`}
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    name="line-tax"
                    value={row.tax}
                    onChange={(event) => update(index, { tax: event.target.value })}
                    className={`${controlClassName} w-16`}
                    aria-label={`Tax rate for line ${index + 1}`}
                  />
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    className="text-sm text-[var(--color-text-muted)] underline"
                    aria-label={`Remove line ${index + 1}`}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => setRows((current) => [...current, emptyRow(current.length)])}
        className="self-start text-sm underline"
      >
        Add a line
      </button>
    </>
  );
}

/** Raising a quotation, from a deal or from a party directly. */
export function NewQuotationForm({
  dealId,
  leadId,
  customerId,
  products,
  currency,
  copiesDealLines,
}: {
  dealId?: string;
  leadId?: string;
  customerId?: string;
  products: Product[];
  currency: string;
  copiesDealLines: boolean;
}) {
  const [state, action, pending] = useActionState(createQuotation, IDLE);
  const [rows, setRows] = useState<LineRow[]>(copiesDealLines ? [] : [emptyRow(0)]);

  return (
    <form action={action} className="flex flex-col gap-4">
      {dealId && <input type="hidden" name="dealId" value={dealId} />}
      {leadId && <input type="hidden" name="leadId" value={leadId} />}
      {customerId && <input type="hidden" name="customerId" value={customerId} />}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" hint="What the customer sees at the top. Optional.">
          <input
            name="title"
            className={controlClassName}
            defaultValue={valueOf(state, 'title', '')}
            placeholder="Website build and launch"
          />
        </Field>
        <Field label="Valid until" hint="The last day the price stands. Optional.">
          <input
            name="validUntil"
            type="date"
            className={controlClassName}
            defaultValue={valueOf(state, 'validUntil', '')}
          />
        </Field>
      </div>

      <Field label="Terms" hint="Payment schedule, warranty, anything printed at the foot.">
        <textarea
          name="terms"
          rows={3}
          className={controlClassName}
          defaultValue={valueOf(state, 'terms', '')}
        />
      </Field>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] p-3 text-sm text-[var(--color-text-muted)]">
          The deal’s line items will be copied onto the quotation.{' '}
          <button type="button" onClick={() => setRows([emptyRow(0)])} className="underline">
            Price it differently
          </button>
        </div>
      ) : (
        <LineTable
          rows={rows}
          setRows={setRows}
          products={products}
          currency={currency}
          state={state}
        />
      )}

      <Button type="submit" pending={pending}>
        {pending ? 'Raising…' : 'Raise the quotation'}
      </Button>
    </form>
  );
}

/** Editing a draft's lines. Not offered at all once a version has been sent. */
export function QuotationLinesEditor({
  quotationId,
  items,
  products,
  currency,
}: {
  quotationId: string;
  items: QuotationLine[];
  products: Product[];
  currency: string;
}) {
  const [state, action, pending] = useActionState(setQuotationItems, IDLE);
  const [rows, setRows] = useState<LineRow[]>(() =>
    items.length > 0
      ? items.map((item) => ({
          key: item.id,
          productId: item.productId ?? '',
          name: item.name,
          quantity: String(item.quantity),
          price: rupees(item.unitPriceMinor),
          discount: item.discountMinor === 0 ? '' : rupees(item.discountMinor),
          tax: String(item.taxPercent),
        }))
      : [emptyRow(0)],
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={quotationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <LineTable
        rows={rows}
        setRows={setRows}
        products={products}
        currency={currency}
        state={state}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save lines'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}

/** Title, terms and validity, for a draft. */
export function QuotationDetailsForm({
  quotationId,
  title,
  terms,
  validUntil,
}: {
  quotationId: string;
  title: string | null;
  terms: string | null;
  validUntil: string | null;
}) {
  const [state, action, pending] = useActionState(updateQuotation, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={quotationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Field label="Title">
        <input
          name="title"
          className={controlClassName}
          defaultValue={valueOf(state, 'title', title ?? '')}
        />
      </Field>
      <Field label="Valid until" hint="Leave blank for no expiry.">
        <input
          name="validUntil"
          type="date"
          className={controlClassName}
          defaultValue={valueOf(state, 'validUntil', validUntil ? validUntil.slice(0, 10) : '')}
        />
      </Field>
      <Field label="Terms">
        <textarea
          name="terms"
          rows={4}
          className={controlClassName}
          defaultValue={valueOf(state, 'terms', terms ?? '')}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}

/** Draft → sent. The channel is recorded as evidence, not as a delivery instruction. */
export function SendQuotationForm({ quotationId }: { quotationId: string }) {
  const [state, action, pending] = useActionState(sendQuotation, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={quotationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Field label="How did it go out?">
        <select name="via" className={controlClassName} defaultValue="manual">
          <option value="manual">By hand, or printed</option>
          <option value="email">Email</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="link">A link</option>
        </select>
      </Field>
      <Field label="To" hint="The address or number, for the record. Optional.">
        <input name="to" className={controlClassName} defaultValue={valueOf(state, 'to', '')} />
      </Field>
      <Button type="submit" pending={pending}>
        {pending ? 'Recording…' : 'Mark as sent'}
      </Button>
      <p className="text-xs text-[var(--color-text-muted)]">
        This freezes the version. Changing the price afterwards means raising a revision, so the
        customer keeps the document they were given.
      </p>
    </form>
  );
}

/** Accept or reject, for a sent quotation. */
export function OutcomeForms({
  quotationId,
  lostReasons,
}: {
  quotationId: string;
  lostReasons: { id: string; name: string }[];
}) {
  const [acceptState, acceptAction, accepting] = useActionState(acceptQuotation, IDLE);
  const [rejectState, rejectAction, rejecting] = useActionState(rejectQuotation, IDLE);
  return (
    <div className="flex flex-col gap-5">
      <form action={acceptAction} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={quotationId} />
        {acceptState.status === 'error' && <ErrorNotice>{acceptState.message}</ErrorNotice>}
        <Field label="Accepted" hint="The deal takes this figure, if it is still open.">
          <input
            name="note"
            className={controlClassName}
            placeholder="Signed on the call"
            aria-label="Note about the acceptance"
          />
        </Field>
        <Button type="submit" pending={accepting}>
          {accepting ? 'Recording…' : 'They accepted'}
        </Button>
      </form>

      <form action={rejectAction} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={quotationId} />
        {rejectState.status === 'error' && <ErrorNotice>{rejectState.message}</ErrorNotice>}
        <Field label="Turned down because">
          <select name="reasonId" className={controlClassName} defaultValue="">
            <option value="">No reason recorded</option>
            {lostReasons.map((reason) => (
              <option key={reason.id} value={reason.id}>
                {reason.name}
              </option>
            ))}
          </select>
        </Field>
        <input
          name="note"
          className={controlClassName}
          placeholder="What they said"
          aria-label="Note about the rejection"
        />
        <Button type="submit" variant="secondary" pending={rejecting}>
          {rejecting ? 'Recording…' : 'They turned it down'}
        </Button>
      </form>
    </div>
  );
}

/** A revision: a new version of the same number, as a draft. */
export function ReviseButton({ quotationId }: { quotationId: string }) {
  const [state, action, pending] = useActionState(reviseQuotation, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={quotationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="secondary" pending={pending}>
        {pending ? 'Creating…' : 'Raise a revision'}
      </Button>
      <p className="text-xs text-[var(--color-text-muted)]">
        Keeps the number, adds a version, and leaves what was sent untouched.
      </p>
    </form>
  );
}

export function DeleteQuotationButton({ quotationId }: { quotationId: string }) {
  const [state, action, pending] = useActionState(deleteQuotation, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={quotationId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="danger" pending={pending}>
        {pending ? 'Deleting…' : 'Delete this draft'}
      </Button>
    </form>
  );
}

/** The number series. Under settings, because renumbering affects every quotation that follows. */
export function NumberSeriesForm({
  prefix,
  padding,
  nextValue,
  nextNumber,
}: {
  prefix: string;
  padding: number;
  nextValue: number;
  nextNumber: string;
}) {
  const [state, action, pending] = useActionState(updateNumberSeries, IDLE);
  return (
    <form action={action} className="flex flex-col gap-3">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Prefix" hint="“QTN-”, “Q/2026/”, or nothing.">
          <input
            name="prefix"
            className={controlClassName}
            defaultValue={valueOf(state, 'prefix', prefix)}
          />
        </Field>
        <Field label="Digits" hint="4 renders 7 as 0007.">
          <input
            name="padding"
            type="number"
            min={0}
            max={12}
            className={controlClassName}
            defaultValue={valueOf(state, 'padding', String(padding))}
          />
        </Field>
        <Field label="Next number" hint="Can be moved forward, never back.">
          <input
            name="nextValue"
            type="number"
            min={1}
            className={controlClassName}
            defaultValue={valueOf(state, 'nextValue', String(nextValue))}
          />
        </Field>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        The next quotation will be <strong data-testid="next-number">{nextNumber}</strong>.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save numbering'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}
