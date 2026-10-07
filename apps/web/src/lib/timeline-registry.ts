import { formatDateTime, formatMoney } from './lead-format';

/**
 * The timeline renderer registry (`FR-TL-1`, ADR-0009, docs/frontend-architecture.md §5.2).
 *
 * `activity.type → how to describe it`. Two properties make this worth being a registry rather than
 * a switch inside the component:
 *
 *  * **An unknown type degrades to a readable row rather than crashing.** The API's type list is a
 *    code constant that ships independently of this app, so a backend release that starts writing
 *    `whatsapp.template_sent` before the frontend knows about it must produce a sensible line, not a
 *    blank or an error boundary. That is not hypothetical: every later phase adds types.
 *  * **It is pure**, so the phrasing is testable without rendering anything.
 *
 * A describer returns a sentence. It is given the payload the API stored, which is untyped by
 * design — payload bodies change between releases and an older lead's entry still has to render.
 */

export type ActivityPayload = Readonly<Record<string, unknown>>;

export interface TimelineEntryLike {
  readonly id: string;
  readonly type: string;
  readonly module: string;
  readonly known: boolean;
  readonly occurredAt: string;
  readonly visibility: string;
  readonly actor: { type: string; id: string | null; name: string | null };
  readonly payload: ActivityPayload;
}

export interface RenderedEntry {
  /** A short label for the row's marker. */
  readonly label: string;
  /** One sentence. Never empty — that is the point of the fallback. */
  readonly description: string;
  readonly tone: 'neutral' | 'success' | 'warning' | 'danger';
}

type Describer = (payload: ActivityPayload) => {
  label: string;
  description: string;
  tone?: RenderedEntry['tone'];
};

const text = (payload: ActivityPayload, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};
const number = (payload: ActivityPayload, key: string): number | null => {
  const value = payload[key];
  return typeof value === 'number' ? value : null;
};
/**
 * A money amount from a payload, formatted.
 *
 * Minor units cross the wire, so a timeline that printed the raw number would say a deal was won
 * for "6320000" — which is the paise, and is the figure nobody means.
 */
/**
 * A timestamp from a payload, as a date and time somebody reads.
 *
 * Deliberately not `toLocaleString()` with no options: a bare locale string is ambiguous about
 * day and month, which is the trap the CSV export already paid for. `formatDateTime` is the one
 * format the rest of the app uses.
 */
const dueAt = (payload: ActivityPayload, key = 'dueAt'): string | null => {
  const value = payload[key];
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : formatDateTime(value);
};
const money = (payload: ActivityPayload, key: string, currencyKey: string): string | null => {
  const minor = number(payload, key);
  if (minor === null) return null;
  return formatMoney(minor, text(payload, currencyKey) ?? 'INR');
};

/**
 * Only the types Phase 2 can actually produce are described here.
 *
 * Adding a describer for `whatsapp.sent` today would be writing copy for a screen nobody can reach,
 * and it would rot before it was read. The fallback covers them until their phase lands, which is
 * exactly what the fallback is for.
 */
const DESCRIBERS: Readonly<Record<string, Describer>> = {
  'lead.created': (payload) => ({
    label: 'Captured',
    description: `${text(payload, 'fullName') ?? 'This lead'} was captured${
      text(payload, 'createdVia') ? ` via ${humanise(text(payload, 'createdVia')!)}` : ''
    }.`,
  }),
  'lead.source_captured': (payload) => ({
    label: 'Source',
    description: `Came in through ${humanise(text(payload, 'channel') ?? 'an unknown channel')}${
      text(payload, 'sourceName') ? ` — ${text(payload, 'sourceName')}` : ''
    }.`,
  }),
  'lead.assigned': (payload) => ({
    label: 'Assigned',
    description: assignmentSentence(payload),
  }),
  'lead.reassigned': (payload) => ({
    label: 'Reassigned',
    description: assignmentSentence(payload),
  }),
  'lead.unassigned': () => ({
    label: 'Unassigned',
    description: 'Returned to the unassigned pool.',
    tone: 'warning',
  }),
  'lead.status_changed': (payload) => ({
    label: 'Status',
    description: `Status moved from ${text(payload, 'fromStatus') ?? 'its previous status'} to ${
      text(payload, 'toStatus') ?? 'a new status'
    }.`,
  }),
  'lead.stage_changed': (payload) => ({
    label: 'Stage',
    description: `Moved from ${text(payload, 'fromStage') ?? 'its previous stage'} to ${
      text(payload, 'toStage') ?? 'a new stage'
    }.`,
  }),
  'lead.score_changed': (payload) => {
    const score = number(payload, 'score');
    const previous = number(payload, 'previousScore');
    const band = text(payload, 'band');
    const previousBand = text(payload, 'previousBand');
    const movement =
      previous !== null && score !== null
        ? `${previous} → ${score}`
        : score !== null
          ? String(score)
          : 'changed';
    return {
      label: 'Score',
      description: band
        ? `Now ${band}${previousBand ? ` (was ${previousBand})` : ''} — score ${movement}.`
        : `Score ${movement}.`,
      tone: previous !== null && score !== null && score < previous ? 'warning' : 'neutral',
    };
  },
  'lead.field_updated': (payload) => {
    const fields = payload['fields'];
    const list = Array.isArray(fields) ? fields.filter((entry) => typeof entry === 'string') : [];
    return {
      label: 'Edited',
      description:
        list.length > 0
          ? `Updated ${list.map((entry) => humanise(String(entry))).join(', ')}.`
          : 'Details were updated.',
    };
  },
  'lead.tagged': (payload) => ({
    label: 'Tagged',
    description: `Tagged ${namesFrom(payload, 'tags') ?? 'this lead'}.`,
  }),
  'lead.untagged': (payload) => ({
    label: 'Untagged',
    description: `Removed ${namesFrom(payload, 'tags') ?? 'a tag'}.`,
  }),
  'lead.duplicate_detected': (payload) => ({
    label: 'Possible duplicate',
    description: `Looks like ${text(payload, 'matchedLeadName') ?? 'an existing lead'}${
      namesFrom(payload, 'matchedFields') ? ` — same ${namesFrom(payload, 'matchedFields')}` : ''
    }.`,
    tone: 'warning',
  }),
  'lead.merged': (payload) => ({
    label: 'Merged',
    description: `Merged with ${text(payload, 'mergedLeadName') ?? 'another lead'}.`,
  }),
  'lead.recycled': (payload) => ({
    label: 'Recycled',
    description: `Returned to the pool after ${
      number(payload, 'idleDays') ?? 'several'
    } days with no activity.`,
    tone: 'warning',
  }),
  'lead.converted': (payload) => ({
    label: 'Converted',
    description: text(payload, 'customerName')
      ? `Became a customer — ${text(payload, 'customerName')}.`
      : 'Became a customer.',
    tone: 'success',
  }),
  // The customer side of the same moment. Phrased differently on purpose: both entries appear in a
  // converted person's journey, and two identical sentences would read as a duplicated row.
  'customer.created': (payload) => ({
    label: 'Customer',
    description: text(payload, 'leadName')
      ? `Account opened, carried over from ${text(payload, 'leadName')}.`
      : 'Account opened.',
    tone: 'success',
  }),
  'customer.updated': (payload) => {
    const fields = payload['fields'];
    const list = Array.isArray(fields) ? fields.filter((entry) => typeof entry === 'string') : [];
    return {
      label: 'Updated',
      description:
        list.length > 0
          ? `Changed ${list.map((entry) => humanise(String(entry))).join(', ')}.`
          : 'Account details changed.',
    };
  },
  // Deals (`FR-DEAL-1`). The value and the note are in the payload and were never shown: a timeline
  // that says only "Deal won" is one a business owner has to ask about.
  'deal.created': (payload) => ({
    label: 'Deal',
    description: `Opened${text(payload, 'name') ? ` — ${text(payload, 'name')}` : ''}${
      money(payload, 'valueMinor', 'currency')
        ? ` at ${money(payload, 'valueMinor', 'currency')}`
        : ''
    }.`,
  }),
  'deal.updated': (payload) => {
    const fields = payload['fields'];
    const list = Array.isArray(fields) ? fields.filter((entry) => typeof entry === 'string') : [];
    return {
      label: 'Deal',
      description:
        list.length > 0
          ? `Changed ${list.map((entry) => humanise(String(entry))).join(', ')}.`
          : money(payload, 'valueMinor', 'currency')
            ? `Line items changed; now ${money(payload, 'valueMinor', 'currency')}.`
            : 'Deal updated.',
    };
  },
  'deal.stage_changed': (payload) => ({
    label: 'Deal',
    description: `Moved to ${text(payload, 'toStageName') ?? 'another stage'}${
      number(payload, 'probability') === null ? '' : ` (${number(payload, 'probability')}%)`
    }.`,
  }),
  'deal.won': (payload) => ({
    label: 'Won',
    description: `${money(payload, 'valueMinor', 'currency') ?? 'The deal'} won${
      text(payload, 'note') ? ` — ${text(payload, 'note')}` : ''
    }.`,
    tone: 'success',
  }),
  'deal.lost': (payload) => ({
    label: 'Lost',
    description: `${money(payload, 'valueMinor', 'currency') ?? 'The deal'} lost${
      text(payload, 'note') ? ` — ${text(payload, 'note')}` : ''
    }.`,
    tone: 'danger',
  }),
  'deal.reopened': () => ({
    label: 'Deal',
    description: 'Reopened. The earlier outcome stays above — it happened.',
  }),
  'deal.deleted': () => ({
    label: 'Deal',
    description: 'Deleted. Restorable from the recycle bin.',
    tone: 'danger',
  }),
  'quotation.created': (payload) => ({
    label: 'Quotation',
    description: `${text(payload, 'number') ?? 'A quotation'} drafted${
      money(payload, 'totalMinor', 'currency')
        ? ` at ${money(payload, 'totalMinor', 'currency')}`
        : ''
    }.`,
  }),
  'quotation.sent': (payload) => {
    const via = text(payload, 'via');
    const to = text(payload, 'to');
    const channel =
      via === 'manual' || via === null
        ? ''
        : ` by ${via === 'link' ? 'a link' : via}${to ? ` to ${to}` : ''}`;
    return {
      label: 'Quotation',
      description: `${text(payload, 'number') ?? 'A quotation'} sent${channel}${
        money(payload, 'totalMinor', 'currency')
          ? ` — ${money(payload, 'totalMinor', 'currency')}`
          : ''
      }${text(payload, 'validUntil') ? `, valid until ${text(payload, 'validUntil')}` : ''}.`,
    };
  },
  'quotation.revised': (payload) => ({
    label: 'Quotation',
    description: `${text(payload, 'number') ?? 'A quotation'} revised to version ${
      number(payload, 'version') ?? '2'
    }${
      money(payload, 'fromTotalMinor', 'currency') && money(payload, 'totalMinor', 'currency')
        ? ` — ${money(payload, 'fromTotalMinor', 'currency')} became ${money(payload, 'totalMinor', 'currency')}`
        : ''
    }. What was sent before is unchanged.`,
  }),
  'quotation.accepted': (payload) => ({
    label: 'Accepted',
    description: `${text(payload, 'number') ?? 'The quotation'} accepted${
      money(payload, 'totalMinor', 'currency')
        ? ` at ${money(payload, 'totalMinor', 'currency')}`
        : ''
    }${
      payload['dealValueUpdated'] === true
        ? '; the deal now carries that figure'
        : payload['dealClosed'] === true
          ? '; the deal is already closed, so its value is unchanged — reopen it to carry this figure'
          : ''
    }${text(payload, 'note') ? ` — ${text(payload, 'note')}` : ''}.`,
    tone: 'success',
  }),
  'quotation.rejected': (payload) => ({
    label: 'Rejected',
    description: `${text(payload, 'number') ?? 'The quotation'} turned down${
      text(payload, 'note') ? ` — ${text(payload, 'note')}` : ''
    }.`,
    tone: 'danger',
  }),
  'quotation.expired': (payload) => ({
    label: 'Expired',
    description: `${text(payload, 'number') ?? 'The quotation'} passed its validity date. Revise it to re-issue the price.`,
    tone: 'warning',
  }),
  'payment.recorded': (payload) => ({
    label: 'Payment',
    description: `${money(payload, 'amountMinor', 'currency') ?? 'A payment'} recorded${
      text(payload, 'method') ? ` by ${text(payload, 'method')}` : ''
    }, not yet cleared${text(payload, 'reference') ? ` (${text(payload, 'reference')})` : ''}.`,
    tone: 'warning',
  }),
  'payment.received': (payload) => ({
    label: 'Paid',
    description: `${money(payload, 'amountMinor', 'currency') ?? 'A payment'} received${
      text(payload, 'method') ? ` by ${text(payload, 'method')}` : ''
    }${text(payload, 'reference') ? ` (${text(payload, 'reference')})` : ''}${
      text(payload, 'note') ? ` — ${text(payload, 'note')}` : ''
    }.`,
    tone: 'success',
  }),
  'payment.failed': (payload) => ({
    label: 'Failed',
    description: `${money(payload, 'amountMinor', 'currency') ?? 'A payment'} did not clear${
      text(payload, 'note') ? ` — ${text(payload, 'note')}` : ''
    }. It is out of every total.`,
    tone: 'danger',
  }),
  'payment.refunded': (payload) => ({
    label: 'Refunded',
    description: `${money(payload, 'amountMinor', 'currency') ?? 'A payment'} refunded${
      text(payload, 'note') ? ` — ${text(payload, 'note')}` : ''
    }. The receipt stays; the money does not.`,
    tone: 'warning',
  }),
  'customer.deleted': () => ({
    label: 'Deleted',
    description: 'Moved to the recycle bin. Nothing about the history is gone.',
    tone: 'danger',
  }),
  'customer.restored': () => ({ label: 'Restored', description: 'Brought back from the bin.' }),
  'lead.lost': (payload) => ({
    label: 'Lost',
    description: `Marked lost${text(payload, 'reason') ? ` — ${text(payload, 'reason')}` : ''}.`,
    tone: 'danger',
  }),
  'lead.reopened': () => ({ label: 'Reopened', description: 'Reopened for another attempt.' }),
  'lead.deleted': () => ({
    label: 'Deleted',
    description: 'Moved to the recycle bin.',
    tone: 'warning',
  }),
  'lead.restored': () => ({
    label: 'Restored',
    description: 'Restored from the recycle bin.',
  }),
  'note.added': (payload) => ({
    label: 'Note',
    description: text(payload, 'body') ?? 'A note was added.',
  }),

  // ── Tasks and follow-ups (`FR-TSK-1..6`) ─────────────────────────────────
  //
  // Written the day the tasks module started emitting them. A type with no describer renders as a
  // bare row and loses everything in its payload, which is how `deal.won` once reached a screen
  // without its amount — so adding an activity type is two edits, and this is the second.
  'task.created': (payload) => ({
    label: 'Planned',
    description: `${text(payload, 'taskType') ?? 'Follow-up'} — ${
      text(payload, 'title') ?? 'a follow-up'
    }, due ${dueAt(payload) ?? 'later'}${
      text(payload, 'followsTaskId') ? ', following the last one' : ''
    }.`,
  }),
  'task.completed': (payload) => {
    const next = payload['nextFollowUp'];
    const planned =
      next !== null && typeof next === 'object'
        ? ((next as Record<string, unknown>)['title'] as string | undefined)
        : undefined;
    return {
      label: 'Done',
      description: `${text(payload, 'title') ?? 'A follow-up'} — ${
        text(payload, 'outcome') ?? 'completed'
      }${text(payload, 'note') ? ` (${text(payload, 'note')})` : ''}${
        planned ? `. Next: ${planned}` : ''
      }.`,
      // Only a *positive* outcome is green. "No answer" is not progress, and a timeline where
      // every completion reads as success is one nobody can scan for the ones that went well.
      tone: payload['outcomeIsPositive'] === true ? ('success' as const) : ('neutral' as const),
    };
  },
  'task.rescheduled': (payload) => ({
    label: 'Moved',
    description: `${text(payload, 'title') ?? 'A follow-up'} moved to ${
      dueAt(payload, 'toDueAt') ?? 'another time'
    } — ${text(payload, 'reason') ?? 'no reason given'}${
      text(payload, 'note') ? ` (${text(payload, 'note')})` : ''
    }${
      // The coaching signal in `FR-TSK-5`: a number with no story is not actionable, and a story
      // without the count does not say how often.
      (number(payload, 'rescheduleCount') ?? 0) > 2
        ? `. Moved ${number(payload, 'rescheduleCount')} times now`
        : ''
    }.`,
    tone: (number(payload, 'rescheduleCount') ?? 0) > 2 ? 'warning' : 'neutral',
  }),
  'task.cancelled': (payload) => ({
    label: 'Cancelled',
    description: `${text(payload, 'title') ?? 'A follow-up'} was called off${
      text(payload, 'reason') ? ` — ${text(payload, 'reason')}` : ''
    }.`,
    tone: 'warning',
  }),
  'task.overdue': (payload) => ({
    label: 'Missed',
    description: `${text(payload, 'title') ?? 'A follow-up'} was due ${
      dueAt(payload) ?? 'earlier'
    } and has not been done.`,
    tone: 'danger',
  }),

  // ── SLA (`FR-TSK-8`) ──────────────────────────────────────────────────────
  //
  // The sentence names the **promise**, not the clock: "First response within an hour" is what a
  // business owner recognises, and `sla_clock 01a1…` is not. The target is spelled out in words for
  // the same reason — `first_response` is a column name.
  'sla.at_risk': (payload) => ({
    label: 'Running out',
    description: `${slaTarget(payload)} is nearly out of time${
      text(payload, 'policy') ? ` — ${text(payload, 'policy')}` : ''
    }${dueAt(payload) ? `, due ${dueAt(payload)}` : ''}.`,
    tone: 'warning',
  }),
  'sla.breached': (payload) => ({
    label: 'SLA missed',
    description: `${slaTarget(payload)} passed its deadline${
      text(payload, 'policy') ? ` — ${text(payload, 'policy')}` : ''
    }${
      number(payload, 'targetMinutes')
        ? ` (${number(payload, 'targetMinutes')} working minutes)`
        : ''
    }.`,
    tone: 'danger',
  }),
};

/** `first_response` is a column name; "The first response" is a sentence. */
function slaTarget(payload: ActivityPayload): string {
  switch (text(payload, 'target')) {
    case 'first_response':
      return 'The first response';
    case 'next_response':
      return 'The next reply';
    case 'resolution':
      return 'Closing this out';
    default:
      return 'The response';
  }
}

function assignmentSentence(payload: ActivityPayload): string {
  const to = text(payload, 'toUserName') ?? text(payload, 'assignedUserName');
  const rule = text(payload, 'ruleName');
  const reason = text(payload, 'reason');
  const who = to ? `Assigned to ${to}` : 'Assignment changed';
  if (rule) return `${who} by “${rule}”.`;
  if (reason) return `${who} — ${reason}.`;
  return `${who}.`;
}

function namesFrom(payload: ActivityPayload, key: string): string | null {
  const value = payload[key];
  if (!Array.isArray(value)) return null;
  const names = value
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name
          : null,
    )
    .filter((entry): entry is string => entry !== null);
  return names.length > 0 ? names.join(', ') : null;
}

/**
 * `meta_ads` → `Meta ads`, and `jobTitle` → `Job title`.
 *
 * Both cases turn up in the same place: a channel or an activity type arrives snake_cased or
 * dotted, while the `fields` list on an edit entry carries the API's **camelCase** property names.
 * Without the camelCase split a timeline read "Changed JobTitle" and "Changed billingLine1" — which
 * is the field name a developer uses, shown to a business owner.
 */
export function humanise(value: string): string {
  const spaced = value
    .replace(/[_.]/g, ' ')
    // Split camelCase, and keep an acronym together: `taxId` → `tax Id`, `GSTIN` stays `GSTIN`.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  const lowered = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  // Only the first word is capitalised: "Job title", not "Job Title" — a sentence, not a heading.
  return lowered.replace(
    /\s+([A-Z])(?=[a-z])/g,
    (_match, letter: string) => ` ${letter.toLowerCase()}`,
  );
}

/**
 * Describes an entry, always.
 *
 * The fallback is the load-bearing part: it turns `whatsapp.template_sent` into
 * "Whatsapp template sent" with the module as its label, so a type this build has never heard of
 * still reads as a sentence on a customer's timeline.
 */
export function describeEntry(entry: TimelineEntryLike): RenderedEntry {
  const describer = DESCRIBERS[entry.type];
  if (describer) {
    const described = describer(entry.payload ?? {});
    return {
      label: described.label,
      description: described.description,
      tone: described.tone ?? 'neutral',
    };
  }
  const [, action] = entry.type.split('.');
  return {
    label: humanise(entry.module),
    description: action ? `${humanise(`${entry.module} ${action}`)}.` : `${humanise(entry.type)}.`,
    tone: 'neutral',
  };
}

/** Whether this build knows how to phrase a type, for the "types we cannot describe yet" check. */
export function hasDescriber(type: string): boolean {
  return type in DESCRIBERS;
}

/** The actor's display name, falling back to what the entry says it was. */
export function actorName(entry: TimelineEntryLike): string {
  if (entry.actor.name) return entry.actor.name;
  return entry.actor.type === 'system' ? 'Automatically' : 'Someone';
}
