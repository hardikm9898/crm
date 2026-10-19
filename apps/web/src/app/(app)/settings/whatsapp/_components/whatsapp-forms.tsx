'use client';

import { useActionState } from 'react';
import { Button, ErrorNotice } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import type { WhatsAppNumber } from '@/lib/whatsapp';
import { connectWhatsApp, setDefaultAgent } from '../actions';

/** Discovers (or re-discovers) the numbers a connection's token can see. */
export function ConnectWabaForm({
  connectionId,
  connectionName,
  alreadyConnected,
}: {
  connectionId: string;
  connectionName: string;
  alreadyConnected: boolean;
}) {
  const [state, submit, pending] = useActionState(connectWhatsApp, IDLE);
  return (
    <form action={submit} className="flex flex-col gap-2" data-connect-waba={connectionId}>
      <input type="hidden" name="connectionId" value={connectionId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p className="text-xs text-[var(--color-success)]" data-connect-result={connectionId}>
          {state.message}
        </p>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending
            ? 'Asking WhatsApp…'
            : alreadyConnected
              ? `Refresh the numbers on ${connectionName}`
              : `Connect ${connectionName}`}
        </Button>
      </div>
    </form>
  );
}

/**
 * Who answers this number when nobody has claimed a conversation.
 *
 * The select is remounted on the echoed value rather than controlled: a `<select>` does not come
 * back from a refused submission through `defaultValue` alone, and a controlled `value` lost the
 * choice because React re-created the options in the same commit. `key` + `defaultValue` is the
 * form that works — the payment-method lesson, in the next place it applies.
 */
export function DefaultAgentForm({
  number,
  members,
}: {
  number: WhatsAppNumber;
  // `userId`, not `id`: a person-reference in this product is a membership's user id, which is
  // what every assignment column stores.
  members: readonly { userId: string; name: string }[];
}) {
  const [state, submit, pending] = useActionState(setDefaultAgent, IDLE);
  // `values` only exists on a refusal, which is the only time there is a submission to echo.
  const echoed =
    (state.status === 'error' ? state.values?.['userId'] : undefined) ??
    number.defaultAgentUserId ??
    '';
  return (
    <form action={submit} className="flex flex-wrap items-end gap-2" data-agent-form={number.id}>
      <input type="hidden" name="numberId" value={number.id} />
      <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        Answers by default
        <select
          name="userId"
          key={`agent-${echoed}`}
          defaultValue={echoed}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-text)]"
        >
          <option value="">Nobody — anyone can pick it up</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {state.status === 'success' && (
        <p className="text-xs text-[var(--color-success)]" data-agent-result={number.id}>
          {state.message}
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}
