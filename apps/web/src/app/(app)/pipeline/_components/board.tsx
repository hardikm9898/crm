'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge, Button, ErrorNotice } from '@/components/ui';
import { formatMoney, formatPhone, relativeTime } from '@/lib/lead-format';
import type { LeadSummary, StageSummary } from '@/lib/leads';
import { moveLeadToStage } from '../actions';

/**
 * The kanban board (`FR-PIP-2`).
 *
 * **Each column is its own page of leads** (`NFR-PERF-4`): the server fetched a page per stage and
 * "Load more" grows that column alone, through the URL. A board that loaded every lead in a stage
 * would be unusable for the tenant who most needs a board.
 *
 * Moving a lead is available two ways on purpose. Dragging is what people expect; a select on each
 * card is what works with a keyboard, with a screen reader, and on a phone where dragging between
 * off-screen columns is not possible. Both post to the same server action, so both go through the
 * API's validation of the destination stage's required fields.
 */
export function Board({
  stages,
  leadsByStage,
  counts,
  valueByStage,
  loadedPerStage,
  canMove,
  now,
}: {
  stages: StageSummary[];
  leadsByStage: Record<string, LeadSummary[]>;
  counts: Record<string, number>;
  valueByStage: Record<string, number>;
  loadedPerStage: Record<string, number>;
  canMove: boolean;
  now: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const at = new Date(now);

  function move(leadId: string, stageId: string) {
    setError(null);
    const form = new FormData();
    form.set('leadId', leadId);
    form.set('stageId', stageId);
    startTransition(async () => {
      const result = await moveLeadToStage({ status: 'idle' }, form);
      if (result.status === 'error') setError(result.message);
      else router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {pending && (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          Moving…
        </p>
      )}

      <div className="flex gap-3 overflow-x-auto pb-4">
        {stages.map((stage) => {
          const leads = leadsByStage[stage.id] ?? [];
          const total = counts[stage.id] ?? leads.length;
          const loaded = loadedPerStage[stage.id] ?? leads.length;
          return (
            <section
              key={stage.id}
              onDragOver={(event) => {
                if (!canMove || !dragging) return;
                event.preventDefault();
                setOver(stage.id);
              }}
              onDragLeave={() => setOver((current) => (current === stage.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                const leadId = event.dataTransfer.getData('text/lead-id') || dragging;
                setDragging(null);
                if (canMove && leadId) move(leadId, stage.id);
              }}
              aria-label={`${stage.name}, ${total} ${total === 1 ? 'lead' : 'leads'}`}
              className={`flex w-72 shrink-0 flex-col rounded-[var(--radius-card)] border bg-[var(--color-surface-raised)] ${
                over === stage.id ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]'
              }`}
            >
              <header className="border-b border-[var(--color-border)] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    {stage.colour && (
                      <span
                        aria-hidden
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: stage.colour }}
                      />
                    )}
                    {stage.name}
                  </h2>
                  <span className="numeric text-xs text-[var(--color-text-muted)]">{total}</span>
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                  {formatMoney(valueByStage[stage.id] ?? 0, 'INR')}
                  {stage.probability > 0 ? ` · ${stage.probability}%` : ''}
                </p>
              </header>

              <ol className="flex min-h-24 flex-col gap-2 p-2">
                {leads.length === 0 && (
                  <li className="px-1 py-4 text-center text-xs text-[var(--color-text-muted)]">
                    Nothing here
                  </li>
                )}
                {leads.map((lead) => (
                  <li
                    key={lead.id}
                    draggable={canMove}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/lead-id', lead.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging(lead.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={`rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 ${
                      canMove ? 'cursor-grab' : ''
                    } ${dragging === lead.id ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/leads/${lead.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {lead.fullName}
                      </Link>
                      <span className="numeric text-xs text-[var(--color-text-muted)]">
                        {lead.score}
                      </span>
                    </div>
                    <p className="truncate text-xs text-[var(--color-text-muted)]">
                      {formatPhone(lead.phone)}
                      {lead.city ? ` · ${lead.city}` : ''}
                    </p>
                    {lead.valueMinor !== null && (
                      <p className="numeric mt-1 text-xs">
                        {formatMoney(lead.valueMinor, lead.currency)}
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {lead.scoreBand && <Badge>{lead.scoreBand}</Badge>}
                      <span className="ml-auto text-xs text-[var(--color-text-muted)]">
                        {relativeTime(lead.lastActivityAt ?? lead.createdAt, at)}
                      </span>
                    </div>

                    {canMove && (
                      <label className="mt-2 block text-xs">
                        <span className="sr-only">Move {lead.fullName} to another stage</span>
                        <select
                          value={stage.id}
                          onChange={(event) => move(lead.id, event.target.value)}
                          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1 text-xs"
                        >
                          {stages.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.id === stage.id
                                ? `In ${option.name}`
                                : `Move to ${option.name}`}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </li>
                ))}
              </ol>

              {total > loaded && (
                <div className="border-t border-[var(--color-border)] p-2">
                  <Link href={`/pipeline?more=${stage.id}&loaded=${loaded + 10}`} className="block">
                    <Button variant="quiet">Load 10 more ({total - loaded} left)</Button>
                  </Link>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
