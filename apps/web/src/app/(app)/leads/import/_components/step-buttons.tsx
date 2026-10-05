'use client';

import { useActionState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Button, ErrorNotice } from '@/components/ui';
import { cancelImport, checkImport, startImport } from '../actions';

/**
 * The three one-press steps: check the file, import it, stop it.
 *
 * Each is its own form so its own pending state is its own — a person who presses “Import” should
 * see that button working, not every button on the screen disabled.
 */
export function CheckButton({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(checkImport, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div>
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? 'Checking every row…' : 'Check the file'}
        </Button>
      </div>
    </form>
  );
}

export function StartButton({ jobId, rows }: { jobId: string; rows: number }) {
  const [state, action, pending] = useActionState(startImport, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <div>
        <Button type="submit" pending={pending}>
          {pending ? 'Starting…' : `Import ${rows.toLocaleString('en-IN')} rows`}
        </Button>
      </div>
    </form>
  );
}

export function CancelButton({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(cancelImport, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="jobId" value={jobId} />
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="quiet" pending={pending}>
        {pending ? 'Stopping…' : 'Stop the import'}
      </Button>
    </form>
  );
}
