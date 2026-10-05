'use client';

import { useActionState, useState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Button, ErrorNotice } from '@/components/ui';
import { createExport } from '../import/actions';

/**
 * Exports the list on screen (`FR-IO-3`).
 *
 * The filter travels with the request rather than being re-derived on the server, so what is
 * exported is what the person is looking at — including a saved view, which the API resolves at
 * generation time so the export reflects the view's current definition.
 *
 * The column choice is deliberately *not* here. The default set is what a person wants nine times
 * out of ten, and a column picker in a dropdown would be the kind of thing that makes somebody
 * close the dropdown and go back to copying rows by hand. Choosing columns lives on the exports
 * screen, next to the files.
 */
export function ExportButton({
  viewId,
  filter,
}: {
  viewId: string | null;
  filter: { conditions: unknown[] } | null;
}) {
  const [state, action, pending] = useActionState(createExport, IDLE);
  const [open, setOpen] = useState(false);

  // An export of everything is almost never what somebody means, so the unfiltered case asks once
  // rather than quietly generating a file of the whole workspace.
  const needsConfirmation = !viewId && (!filter || filter.conditions.length === 0);

  return (
    <form action={action} className="flex items-center gap-2">
      {viewId && <input type="hidden" name="viewId" value={viewId} />}
      {!viewId && (
        <input type="hidden" name="filter" value={JSON.stringify(filter ?? { conditions: [] })} />
      )}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {needsConfirmation && !open ? (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Export
        </Button>
      ) : (
        <Button type="submit" variant="secondary" pending={pending}>
          {pending ? 'Preparing…' : needsConfirmation ? 'Export every lead' : 'Export this list'}
        </Button>
      )}
    </form>
  );
}
