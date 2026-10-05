'use client';

import { useActionState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Button, ErrorNotice } from '@/components/ui';
import { assignLead, changeStage, changeStatus, recomputeScore, setTags } from '../actions';
import type { Option } from '@/lib/leads';

/**
 * The right rail's controls: status, stage, owner, tags.
 *
 * Each is its own form posting to its own action, because each is its own transition on the API with
 * its own permission and preconditions. A single "save" button over all four would have to guess
 * which of them the person meant to change.
 *
 * A status in the `lost` category reveals the reason picker, because the API requires one — better
 * to ask before submitting than to explain a refusal afterwards.
 */
export function StatusControl({
  leadId,
  statuses,
  currentStatusId,
  lostReasons,
}: {
  leadId: string;
  statuses: Option[];
  currentStatusId: string;
  lostReasons: Option[];
}) {
  const [state, action, pending] = useActionState(changeStatus, IDLE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          Status
        </span>
        <select
          name="statusId"
          defaultValue={currentStatusId}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
        >
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      </label>

      {lostReasons.length > 0 && (
        <details className="text-xs text-[var(--color-text-muted)]">
          <summary className="cursor-pointer">If marking lost, give a reason</summary>
          <div className="mt-2 flex flex-col gap-2">
            <select
              name="lostReasonId"
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            >
              <option value="">Choose a reason…</option>
              {lostReasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.name}
                </option>
              ))}
            </select>
            <input
              name="lostNote"
              placeholder="Note (some reasons require one)"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            />
          </div>
        </details>
      )}

      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="secondary" pending={pending}>
        Update status
      </Button>
    </form>
  );
}

export function StageControl({
  leadId,
  stages,
  currentStageId,
}: {
  leadId: string;
  stages: { id: string; name: string; requiredFields?: string[] }[];
  currentStageId: string;
}) {
  const [state, action, pending] = useActionState(changeStage, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          Stage
        </span>
        <select
          name="stageId"
          defaultValue={currentStageId}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
              {stage.requiredFields && stage.requiredFields.length > 0 ? ' *' : ''}
            </option>
          ))}
        </select>
      </label>
      {/* The API validates a stage's required fields and refuses with the list; showing that
          refusal verbatim is more useful than duplicating the rule here and disagreeing with it. */}
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="secondary" pending={pending}>
        Move stage
      </Button>
    </form>
  );
}

export function OwnerControl({
  leadId,
  members,
  currentUserId,
}: {
  leadId: string;
  members: { userId: string; name: string }[];
  currentUserId: string | null;
}) {
  const [state, action, pending] = useActionState(assignLead, IDLE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          Owner
        </span>
        <select
          name="assignedUserId"
          defaultValue={currentUserId ?? ''}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
        >
          <option value="">Unassigned pool</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      <Button type="submit" variant="secondary" pending={pending}>
        Assign
      </Button>
    </form>
  );
}

export function TagsControl({
  leadId,
  tags,
  selected,
}: {
  leadId: string;
  tags: Option[];
  selected: string[];
}) {
  const [state, action, pending] = useActionState(setTags, IDLE);
  const chosen = new Set(selected);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          Tags
        </legend>
        {tags.length === 0 && (
          <p className="text-sm text-[var(--color-text-muted)]">No tags configured yet.</p>
        )}
        {tags.map((tag) => (
          <label key={tag.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="tagIds"
              value={tag.id}
              defaultChecked={chosen.has(tag.id)}
            />
            {tag.name}
          </label>
        ))}
      </fieldset>
      {state.status === 'error' && <ErrorNotice>{state.message}</ErrorNotice>}
      {tags.length > 0 && (
        <Button type="submit" variant="secondary" pending={pending}>
          Save tags
        </Button>
      )}
    </form>
  );
}

export function RecomputeScoreButton({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(recomputeScore, IDLE);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="leadId" value={leadId} />
      <Button type="submit" variant="quiet" pending={pending}>
        Recalculate
      </Button>
      {state.status !== 'idle' && (
        <span
          className={`text-xs ${state.status === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}
          role="status"
        >
          {state.message}
        </span>
      )}
    </form>
  );
}
