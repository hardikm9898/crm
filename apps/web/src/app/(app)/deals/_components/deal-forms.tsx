'use client';

import { useActionState, useState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import type { DealItem, Product } from '@/lib/deals';
import { rupees } from '@/lib/line-items-form';
import {
  createDeal,
  deleteDeal,
  loseDeal,
  moveDeal,
  reopenDeal,
  setDealItems,
  winDeal,
} from '../actions';

function valueOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.values?.[key] : undefined;
}

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

export function NewDealForm({
  leadId,
  customerId,
  stages,
}: {
  leadId?: string;
  customerId?: string;
  stages: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(createDeal, IDLE);

  return (
    <form action={action} className="flex flex-col gap-4">
      {leadId && <input type="hidden" name="leadId" value={leadId} />}
      {customerId && <input type="hidden" name="customerId" value={customerId} />}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      <Field label="What is the deal for" hint={errorOf(state, 'name')}>
        <input
          name="name"
          required
          defaultValue={valueOf(state, 'name')}
          placeholder="3BHK at Prestige Lakeside"
          className={controlClassName}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Value"
          hint={errorOf(state, 'value') ?? 'You can add line items later — they replace this.'}
        >
          <input name="value" defaultValue={valueOf(state, 'value')} className={controlClassName} />
        </Field>
        <Field label="Expected close" hint={errorOf(state, 'expectedCloseDate')}>
          <input
            type="date"
            name="expectedCloseDate"
            defaultValue={valueOf(state, 'expectedCloseDate')}
            className={controlClassName}
          />
        </Field>
      </div>
      {stages.length > 0 && (
        <Field label="Stage" hint="Its probability becomes the deal's.">
          <select name="stageId" defaultValue={stages[0]?.id} className={controlClassName}>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Creating…' : 'Create deal'}
        </Button>
      </div>
    </form>
  );
}

/** Moving a deal along the board. Its own form, so its pending state is its own. */
export function StageControl({
  dealId,
  stages,
  currentStageId,
}: {
  dealId: string;
  stages: { id: string; name: string; probability: number }[];
  currentStageId: string;
}) {
  const [state, action, pending] = useActionState(moveDeal, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={dealId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Field label="Stage">
        <select name="stageId" defaultValue={currentStageId} className={controlClassName}>
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name} · {stage.probability}%
            </option>
          ))}
        </select>
      </Field>
      <div>
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? 'Moving…' : 'Move'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Won and lost.
 *
 * Both are closed by default and ask for one thing before committing: a win takes a note, a loss
 * takes a reason from the workspace's own list. A single button that closed a deal on one click is
 * how a pipeline report ends up full of deals nobody can explain.
 */
export function OutcomeControls({
  dealId,
  outcome,
  lostReasons,
}: {
  dealId: string;
  outcome: 'open' | 'won' | 'lost';
  lostReasons: { id: string; name: string }[];
}) {
  const [winState, winAction, winPending] = useActionState(winDeal, IDLE);
  const [loseState, loseAction, losePending] = useActionState(loseDeal, IDLE);
  const [reopenState, reopenAction, reopenPending] = useActionState(reopenDeal, IDLE);
  const [open, setOpen] = useState<'none' | 'win' | 'lose'>('none');

  if (outcome !== 'open') {
    return (
      <form action={reopenAction} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={dealId} />
        {reopenState.status === 'error' && <ErrorNotice>{reopenState.message}</ErrorNotice>}
        <Button type="submit" variant="secondary" pending={reopenPending}>
          {reopenPending ? 'Reopening…' : 'Reopen this deal'}
        </Button>
        <p className="text-xs text-[var(--color-text-muted)]">
          The won or lost entry stays on the timeline — it happened.
        </p>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {open === 'win' ? (
        <form action={winAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={dealId} />
          {winState.status === 'error' && <ErrorNotice>{winState.message}</ErrorNotice>}
          <Field label="Note" hint="Goes on the timeline, on the deal and on the lead.">
            <input name="note" className={controlClassName} />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="submit" pending={winPending}>
              {winPending ? 'Saving…' : 'Confirm won'}
            </Button>
            <button
              type="button"
              onClick={() => setOpen('none')}
              className="text-sm text-[var(--color-text-muted)] underline"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : open === 'lose' ? (
        <form action={loseAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={dealId} />
          {loseState.status === 'error' && <ErrorNotice>{loseState.message}</ErrorNotice>}
          <Field label="Why was it lost" hint="From your own list, so it can be reported on.">
            <select name="lostReasonId" defaultValue="" className={controlClassName}>
              <option value="">Not saying</option>
              {lostReasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note">
            <input name="note" className={controlClassName} />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="submit" pending={losePending}>
              {losePending ? 'Saving…' : 'Confirm lost'}
            </Button>
            <button
              type="button"
              onClick={() => setOpen('none')}
              className="text-sm text-[var(--color-text-muted)] underline"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setOpen('win')}>
            Won
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen('lose')}>
            Lost
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The line-items editor.
 *
 * A table of inputs submitting parallel arrays, because that is what a table produces and the API
 * takes the list whole (`PUT`). Picking a product fills the name, the price and the tax rate from
 * the catalogue — and then they are **editable**, because a line records what was agreed and the
 * agreed price is often not the list price.
 */
export function LineItemsEditor({
  dealId,
  items,
  products,
  currency,
  disabled,
}: {
  dealId: string;
  items: DealItem[];
  products: Product[];
  currency: string;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(setDealItems, IDLE);
  const [rows, setRows] = useState(() =>
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
      : [
          {
            key: 'new-0',
            productId: '',
            name: '',
            quantity: '1',
            price: '',
            discount: '',
            tax: '',
          },
        ],
  );

  const update = (index: number, patch: Partial<(typeof rows)[number]>) => {
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  };

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

  if (disabled) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        This deal is closed. Reopen it to change what was quoted.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={dealId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="py-2 pr-3 font-medium">Product</th>
              <th className="py-2 pr-3 font-medium">Description</th>
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
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    name="line-quantity"
                    value={row.quantity}
                    onChange={(event) => update(index, { quantity: event.target.value })}
                    className={`${controlClassName} w-20`}
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
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    name="line-tax"
                    value={row.tax}
                    onChange={(event) => update(index, { tax: event.target.value })}
                    className={`${controlClassName} w-16`}
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

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() =>
            setRows((current) => [
              ...current,
              {
                key: `new-${current.length}-${Date.now()}`,
                productId: '',
                name: '',
                quantity: '1',
                price: '',
                discount: '',
                tax: '',
              },
            ])
          }
          className="text-sm underline"
        >
          Add a line
        </button>
        <Button type="submit" pending={pending}>
          {pending ? 'Saving…' : 'Save lines'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        The deal’s value is the total of these lines. Tax is per line, because one quotation often
        mixes rates.
      </p>
    </form>
  );
}

export function DeleteDealButton({ dealId }: { dealId: string }) {
  const [state, action, pending] = useActionState(deleteDeal, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={dealId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="quiet" pending={pending}>
        {pending ? 'Deleting…' : 'Delete deal'}
      </Button>
    </form>
  );
}
