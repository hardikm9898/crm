'use client';

import { useActionState } from 'react';
import { IDLE, type ActionState } from '@/lib/action-state';
import { Button, ErrorNotice, Field, controlClassName } from '@/components/ui';
import { createProduct, setProductActive } from '../../../deals/actions';

function valueOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.values?.[key] : undefined;
}

function errorOf(state: ActionState, key: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[key] : undefined;
}

export function NewProductForm() {
  const [state, action, pending] = useActionState(createProduct, IDLE);

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name" hint={errorOf(state, 'name')}>
          <input
            name="name"
            required
            defaultValue={valueOf(state, 'name')}
            className={controlClassName}
          />
        </Field>
        <Field label="Code" hint={errorOf(state, 'sku') ?? 'Optional, and unique if you use one.'}>
          <input name="sku" defaultValue={valueOf(state, 'sku')} className={controlClassName} />
        </Field>
        <Field label="Price" hint={errorOf(state, 'price')}>
          <input name="price" defaultValue={valueOf(state, 'price')} className={controlClassName} />
        </Field>
        <Field label="Tax %" hint={errorOf(state, 'taxPercent')}>
          <input
            name="taxPercent"
            defaultValue={valueOf(state, 'taxPercent') ?? '18'}
            className={controlClassName}
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" pending={pending}>
          {pending ? 'Adding…' : 'Add product'}
        </Button>
        {state.status === 'success' && (
          <span className="text-sm text-[var(--color-text-muted)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}

/** Deactivating, not deleting: a product that has been sold keeps its name on the record. */
export function ToggleProductButton({ id, isActive }: { id: string; isActive: boolean }) {
  const [state, action, pending] = useActionState(setProductActive, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <button type="submit" disabled={pending} className="text-sm underline disabled:opacity-60">
        {pending ? 'Saving…' : isActive ? 'Deactivate' : 'Reactivate'}
      </button>
    </form>
  );
}
