'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { IDLE } from '@/lib/action-state';
import { Badge, Button, ErrorNotice } from '@/components/ui';
import {
  bandFor,
  bandTone,
  daysSince,
  formatMoney,
  formatPhone,
  priorityTone,
  relativeTime,
  statusTone,
  telHref,
  whatsappHref,
  type BandLike,
} from '@/lib/lead-format';
import type { LeadSummary } from '@/lib/leads';
import { assignLeads, deleteLeads, tagLeads } from '../actions';

/**
 * The lead list, with selection and bulk actions (`FR-LEAD`, `FR-ASG-6`).
 *
 * A client component for one reason: selection is transient state that belongs in the browser.
 * Everything it then *does* goes through a server action, so there is no second copy of a lead in a
 * client cache to go stale.
 *
 * Mobile-first (`NFR-UX-1`): below `sm` each lead is a card with its actions, because a six-column
 * table at 375 px is a horizontal scroll nobody uses. The table appears from `sm` up.
 */
export function LeadTable({
  leads,
  bands,
  members,
  tags,
  now,
  canAssign,
  canDelete,
  canUpdate,
  deleted,
}: {
  leads: LeadSummary[];
  bands: BandLike[];
  members: { userId: string; name: string }[];
  tags: { id: string; name: string }[];
  /** Passed from the server so a relative time is the same on both renders. */
  now: string;
  canAssign: boolean;
  canDelete: boolean;
  canUpdate: boolean;
  deleted: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignState, assign, assigning] = useActionState(assignLeads, IDLE);
  const [tagState, tag, tagging] = useActionState(tagLeads, IDLE);
  const [deleteState, remove, removing] = useActionState(deleteLeads, IDLE);
  const at = new Date(now);

  const allSelected = leads.length > 0 && selected.size === leads.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(leads.map((lead) => lead.id)));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const ids = [...selected];
  const notice = [assignState, tagState, deleteState].find((state) => state.status !== 'idle');

  return (
    <div className="flex flex-col gap-3">
      {notice?.status === 'error' && <ErrorNotice>{notice.message}</ErrorNotice>}
      {notice?.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {notice.message}
        </p>
      )}

      {selected.size > 0 && !deleted && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2">
          <span className="text-sm font-medium">{selected.size} selected</span>

          {canAssign && (
            <form action={assign} className="flex items-center gap-2">
              {ids.map((id) => (
                <input key={id} type="hidden" name="leadIds" value={id} />
              ))}
              <select
                name="assignedUserId"
                defaultValue=""
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm"
                aria-label="Assign selected leads to"
              >
                <option value="">Unassigned pool</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="secondary" pending={assigning}>
                Assign
              </Button>
            </form>
          )}

          {canUpdate && tags.length > 0 && (
            <form action={tag} className="flex items-center gap-2">
              {ids.map((id) => (
                <input key={id} type="hidden" name="leadIds" value={id} />
              ))}
              <select
                name="tagId"
                defaultValue=""
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm"
                aria-label="Add tag to selected leads"
              >
                <option value="">Add tag…</option>
                {tags.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="secondary" pending={tagging}>
                Tag
              </Button>
            </form>
          )}

          {canDelete && (
            <form action={remove}>
              {ids.map((id) => (
                <input key={id} type="hidden" name="leadIds" value={id} />
              ))}
              <Button type="submit" variant="danger" pending={removing}>
                Delete
              </Button>
            </form>
          )}

          <Button variant="quiet" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {/* Mobile: one card per lead. */}
      <ul className="flex flex-col gap-2 sm:hidden">
        {leads.map((lead) => (
          <li
            key={lead.id}
            className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                  {lead.fullName}
                </Link>
                <p className="truncate text-sm text-[var(--color-text-muted)]">
                  {formatPhone(lead.phone)}
                  {lead.city ? ` · ${lead.city}` : ''}
                </p>
              </div>
              <ScoreBadge lead={lead} bands={bands} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={statusTone(lead.status.category)}>{lead.status.name ?? 'Status'}</Badge>
              <Badge>{lead.stage.name ?? 'Stage'}</Badge>
              {lead.priority !== 'medium' && (
                <Badge tone={priorityTone(lead.priority)}>{lead.priority}</Badge>
              )}
            </div>
            <div className="mt-2 flex items-center gap-3 text-sm">
              {telHref(lead.phone) && (
                <a href={telHref(lead.phone)!} className="text-[var(--color-primary)]">
                  Call
                </a>
              )}
              {whatsappHref(lead.whatsapp ?? lead.phone) && (
                <a
                  href={whatsappHref(lead.whatsapp ?? lead.phone)!}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--color-primary)]"
                >
                  WhatsApp
                </a>
              )}
              <span className="ml-auto text-xs text-[var(--color-text-muted)]">
                {relativeTime(lead.lastActivityAt ?? lead.createdAt, at)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop: the table. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
              <th scope="col" className="w-8 py-2 pr-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all leads on this page"
                />
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Lead
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Stage
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Score
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Value
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Owner
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Last activity
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {leads.map((lead) => {
              const idle = daysSince(lead.lastActivityAt ?? lead.createdAt, at);
              return (
                <tr
                  key={lead.id}
                  className={selected.has(lead.id) ? 'bg-[var(--color-surface-muted)]' : undefined}
                >
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.has(lead.id)}
                      onChange={() => toggle(lead.id)}
                      aria-label={`Select ${lead.fullName}`}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                      {lead.fullName}
                    </Link>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {formatPhone(lead.phone)}
                      {lead.city ? ` · ${lead.city}` : ''}
                      {lead.touchCount > 1 ? ` · enquired ${lead.touchCount}×` : ''}
                    </p>
                    {lead.tags.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {lead.tags.map((entry) => (
                          <Badge key={entry.id}>{entry.name}</Badge>
                        ))}
                      </p>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={statusTone(lead.status.category)}>{lead.status.name ?? '—'}</Badge>
                  </td>
                  <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                    {lead.stage.name ?? '—'}
                  </td>
                  <td className="py-2 pr-4">
                    <ScoreBadge lead={lead} bands={bands} />
                  </td>
                  <td className="numeric py-2 pr-4">
                    {formatMoney(lead.valueMinor, lead.currency)}
                  </td>
                  <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                    {lead.assignedUserId
                      ? (members.find((member) => member.userId === lead.assignedUserId)?.name ??
                        'Someone')
                      : 'Unassigned'}
                  </td>
                  <td className="py-2 pr-4 text-[var(--color-text-muted)]">
                    {relativeTime(lead.lastActivityAt ?? lead.createdAt, at)}
                    {idle !== null && idle >= 14 && (
                      <span
                        className="ml-1 text-[var(--color-warning)]"
                        title={`${idle} days quiet`}
                      >
                        ●
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScoreBadge({ lead, bands }: { lead: LeadSummary; bands: BandLike[] }) {
  const band = lead.scoreBand
    ? bands.find((entry) => entry.name === lead.scoreBand)
    : bandFor(lead.score, bands);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="numeric text-sm font-medium">{lead.score}</span>
      {band && <Badge tone={bandTone(band, bands)}>{band.name}</Badge>}
    </span>
  );
}
