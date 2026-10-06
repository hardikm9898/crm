import { describe, expect, it } from 'vitest';
import { ACTIVITY_TYPES } from '@leados/shared';
import {
  actorName,
  describeEntry,
  hasDescriber,
  humanise,
  type TimelineEntryLike,
} from './timeline-registry';

function entry(over: Partial<TimelineEntryLike> = {}): TimelineEntryLike {
  return {
    id: 'a',
    type: over.type ?? 'lead.created',
    module: over.module ?? (over.type ?? 'lead.created').split('.')[0]!,
    known: over.known ?? true,
    occurredAt: '2026-03-18T12:00:00Z',
    visibility: 'all',
    actor: over.actor ?? { type: 'user', id: 'u1', name: 'Anita Sharma' },
    payload: over.payload ?? {},
  };
}

describe('the registry describes what Phase 2 produces', () => {
  it('names the lead and the channel it arrived through', () => {
    const rendered = describeEntry(
      entry({ type: 'lead.created', payload: { fullName: 'Rohan Desai', createdVia: 'meta_ads' } }),
    );
    expect(rendered.description).toBe('Rohan Desai was captured via Meta ads.');
  });

  it('reads a status change in the tenant’s own words', () => {
    const rendered = describeEntry(
      entry({ type: 'lead.status_changed', payload: { fromStatus: 'New', toStatus: 'Qualified' } }),
    );
    expect(rendered.description).toBe('Status moved from New to Qualified.');
  });

  it('shows a score movement with its band, and tones a drop as a warning', () => {
    const up = describeEntry(
      entry({
        type: 'lead.score_changed',
        payload: { score: 70, previousScore: 40, band: 'Hot', previousBand: 'Warm' },
      }),
    );
    expect(up.description).toBe('Now Hot (was Warm) — score 40 → 70.');
    expect(up.tone).toBe('neutral');

    const down = describeEntry(
      entry({
        type: 'lead.score_changed',
        payload: { score: 20, previousScore: 40, band: 'Cold' },
      }),
    );
    expect(down.tone).toBe('warning');
  });

  it('says who assigned it and under which rule', () => {
    expect(
      describeEntry(
        entry({
          type: 'lead.assigned',
          payload: { toUserName: 'Priya Nair', ruleName: 'Round-robin' },
        }),
      ).description,
    ).toBe('Assigned to Priya Nair by “Round-robin”.');
  });

  it('warns about a detected duplicate and names the matching fields', () => {
    const rendered = describeEntry(
      entry({
        type: 'lead.duplicate_detected',
        payload: { matchedLeadName: 'Anita Sharma', matchedFields: ['phoneE164'] },
      }),
    );
    expect(rendered.tone).toBe('warning');
    expect(rendered.description).toContain('Anita Sharma');
  });

  it('survives a payload that is missing everything it hoped for', () => {
    // Payload bodies change between releases and an older lead's entry still has to render.
    for (const type of [
      'lead.created',
      'lead.status_changed',
      'lead.assigned',
      'lead.score_changed',
    ]) {
      const rendered = describeEntry(entry({ type, payload: {} }));
      expect(rendered.description.length).toBeGreaterThan(0);
      expect(rendered.description).not.toContain('undefined');
      expect(rendered.description).not.toContain('null');
    }
  });
});

describe('an unknown type degrades to a sentence, which is the whole point', () => {
  it('describes a type this build has never heard of', () => {
    // A backend release that starts writing a new activity type before the frontend knows about it
    // must produce a readable line, not a blank row or an error boundary (FR-TL-1).
    const rendered = describeEntry(
      entry({ type: 'whatsapp.template_sent', module: 'whatsapp', known: false }),
    );
    expect(rendered.label).toBe('Whatsapp');
    expect(rendered.description).toBe('Whatsapp template sent.');
  });

  it('handles a type with no dot at all', () => {
    const rendered = describeEntry(entry({ type: 'mystery', module: 'mystery' }));
    expect(rendered.description).toBe('Mystery.');
  });

  it('describes every type in the shared registry without throwing or going blank', () => {
    // The list is a code constant that ships independently of this app, so the fallback has to
    // cover all of it — including the phases that have not been built.
    for (const type of Object.values(ACTIVITY_TYPES)) {
      const rendered = describeEntry(entry({ type, module: type.split('.')[0]!, payload: {} }));
      expect(rendered.description.trim().length, type).toBeGreaterThan(1);
      expect(rendered.label.trim().length, type).toBeGreaterThan(0);
    }
  });

  it('knows which types it can phrase itself, so coverage is measurable', () => {
    expect(hasDescriber('lead.created')).toBe(true);
    expect(hasDescriber('whatsapp.template_sent')).toBe(false);
  });
});

describe('actors and wording', () => {
  it('names a person, and says "Automatically" for the system', () => {
    expect(actorName(entry())).toBe('Anita Sharma');
    expect(actorName(entry({ actor: { type: 'system', id: null, name: null } }))).toBe(
      'Automatically',
    );
    expect(actorName(entry({ actor: { type: 'user', id: 'u', name: null } }))).toBe('Someone');
  });

  it('turns wire vocabulary into words', () => {
    expect(humanise('meta_ads')).toBe('Meta ads');
    expect(humanise('lead.stage_changed')).toBe('Lead stage changed');
  });
});

describe('humanising a field name a developer wrote', () => {
  it('splits camelCase into a sentence', () => {
    // The `fields` list on an edit entry carries the API's property names. Showing them raw put
    // "Changed JobTitle" and "Changed billingLine1" in front of business owners.
    expect(humanise('jobTitle')).toBe('Job title');
    expect(humanise('billingLine1')).toBe('Billing line1');
    expect(humanise('taxId')).toBe('Tax id');
  });

  it('still handles snake_case and dotted names', () => {
    expect(humanise('meta_ads')).toBe('Meta ads');
    expect(humanise('whatsapp.template_sent')).toBe('Whatsapp template sent');
  });

  it('leaves a single word alone but capitalised', () => {
    expect(humanise('company')).toBe('Company');
    expect(humanise('City')).toBe('City');
  });
});

describe('a deal on the timeline', () => {
  const entry = (type: string, payload: Record<string, unknown>) =>
    describeEntry({
      id: '1',
      type,
      module: type.split('.')[0]!,
      known: true,
      occurredAt: '2026-10-06T10:00:00.000Z',
      visibility: 'all',
      actor: { type: 'user', id: null, name: 'Anita' },
      payload,
    });

  it('shows the money, not the paise', () => {
    // Minor units cross the wire. A timeline that printed the raw number would say a deal was won
    // for "6320000", which is the figure nobody means.
    expect(entry('deal.won', { valueMinor: 6_320_000, currency: 'INR' }).description).toContain(
      '63,200',
    );
  });

  it('shows the note somebody took the trouble to write', () => {
    expect(
      entry('deal.won', { valueMinor: 100_000, currency: 'INR', note: 'Booking confirmed' })
        .description,
    ).toContain('Booking confirmed');
  });

  it('names the stage a deal moved to, and its probability', () => {
    const described = entry('deal.stage_changed', { toStageName: 'Negotiating', probability: 65 });
    expect(described.description).toContain('Negotiating');
    expect(described.description).toContain('65%');
  });

  it('tones a win and a loss differently', () => {
    expect(entry('deal.won', {}).tone).toBe('success');
    expect(entry('deal.lost', {}).tone).toBe('danger');
  });

  it('still reads when the payload is empty', () => {
    expect(entry('deal.created', {}).description).toBe('Opened.');
    expect(entry('deal.won', {}).description).toBe('The deal won.');
  });
});

describe('the quotation entries', () => {
  const entry = (type: string, payload: Record<string, unknown>) =>
    describeEntry({
      id: 'a',
      type,
      module: type.split('.')[0]!,
      known: true,
      occurredAt: '2026-10-06T10:00:00.000Z',
      visibility: 'all',
      actor: { type: 'user', id: null, name: 'Anita' },
      payload,
    });

  it('names the number, because that is what a customer quotes back at you', () => {
    expect(
      entry('quotation.sent', { number: 'QTN-0007', totalMinor: 118_000, currency: 'INR' })
        .description,
    ).toContain('QTN-0007');
  });

  it('says how it went out, and to whom', () => {
    const described = entry('quotation.sent', {
      number: 'QTN-0007',
      via: 'email',
      to: 'buyer@example.test',
      totalMinor: 118_000,
      currency: 'INR',
    });
    expect(described.description).toContain('by email');
    expect(described.description).toContain('buyer@example.test');
    expect(described.description).toContain('1,180');
  });

  it('does not invent a channel for a quotation handed over in person', () => {
    const described = entry('quotation.sent', { number: 'QTN-0007', via: 'manual' });
    expect(described.description).toBe('QTN-0007 sent.');
  });

  it('shows both figures on a revision, so the change is the sentence', () => {
    const described = entry('quotation.revised', {
      number: 'QTN-0007',
      version: 2,
      fromTotalMinor: 250_000,
      totalMinor: 220_000,
      currency: 'INR',
    });
    expect(described.description).toContain('2,500');
    expect(described.description).toContain('2,200');
    expect(described.description).toContain('unchanged');
  });

  it('says when an acceptance moved the deal’s value', () => {
    expect(
      entry('quotation.accepted', {
        number: 'QTN-0007',
        totalMinor: 118_000,
        currency: 'INR',
        dealValueUpdated: true,
      }).description,
    ).toContain('the deal now carries that figure');
  });

  it('says why the deal’s value did not move, rather than silently not moving it', () => {
    // Found by accepting a quotation on a lost deal: the figure quietly stayed put and nothing on
    // the screen said so, which reads exactly like the acceptance failing to register.
    expect(
      entry('quotation.accepted', {
        number: 'QTN-0007',
        totalMinor: 118_000,
        currency: 'INR',
        dealValueUpdated: false,
        dealClosed: true,
      }).description,
    ).toContain('reopen it');
  });

  it('tones the three outcomes apart', () => {
    expect(entry('quotation.accepted', {}).tone).toBe('success');
    expect(entry('quotation.rejected', {}).tone).toBe('danger');
    expect(entry('quotation.expired', {}).tone).toBe('warning');
  });

  it('tells somebody what to do about an expired quotation', () => {
    expect(entry('quotation.expired', { number: 'QTN-0007' }).description).toContain('Revise it');
  });

  it('still reads when the payload is empty', () => {
    expect(entry('quotation.created', {}).description).toBe('A quotation drafted.');
    expect(entry('quotation.sent', {}).description).toBe('A quotation sent.');
  });
});

describe('the payment entries', () => {
  const entry = (type: string, payload: Record<string, unknown>) =>
    describeEntry({
      id: 'a',
      type,
      module: type.split('.')[0]!,
      known: true,
      occurredAt: '2026-10-06T10:00:00.000Z',
      visibility: 'all',
      actor: { type: 'user', id: null, name: 'Anita' },
      payload,
    });

  it('shows the money, the method and the reference', () => {
    const described = entry('payment.received', {
      amountMinor: 7_000_000,
      currency: 'INR',
      method: 'Cheque',
      reference: '004213',
    });
    expect(described.description).toContain('70,000');
    expect(described.description).toContain('by Cheque');
    expect(described.description).toContain('004213');
    expect(described.tone).toBe('success');
  });

  it('says a pending payment is not cleared, and tones it as a warning', () => {
    const described = entry('payment.recorded', { amountMinor: 100_000, currency: 'INR' });
    expect(described.description).toContain('not yet cleared');
    expect(described.tone).toBe('warning');
  });

  it('says a failed payment has left every total', () => {
    const described = entry('payment.failed', {
      amountMinor: 100_000,
      currency: 'INR',
      note: 'Returned unpaid',
    });
    expect(described.description).toContain('Returned unpaid');
    expect(described.description).toContain('out of every total');
    expect(described.tone).toBe('danger');
  });

  it('says a refund keeps the receipt', () => {
    expect(
      entry('payment.refunded', { amountMinor: 100_000, currency: 'INR' }).description,
    ).toContain('receipt stays');
  });

  it('still reads when the payload is empty', () => {
    expect(entry('payment.received', {}).description).toBe('A payment received.');
  });
});

describe('every activity type the product writes has a describer', () => {
  /**
   * The types no code emits yet, each with the phase that will.
   *
   * This list is the point of the test: a type with no describer renders as a bare row, which is
   * how `deal.won` once reached a screen without its amount or its note. Keeping the gap written
   * down means "does the timeline show every event we produce?" has an answer that is checked
   * rather than remembered — and the day a step starts writing one of these, deleting the line is
   * part of the work.
   */
  const NOT_WRITTEN_YET: Readonly<Record<string, number>> = {
    'task.created': 3,
    'task.completed': 3,
    'task.rescheduled': 3,
    'task.cancelled': 3,
    'task.overdue': 3,
    'mention.created': 3,
    'document.uploaded': 3,
    'sla.at_risk': 3,
    'sla.breached': 3,
    'consent.granted': 13,
    'consent.revoked': 13,
  };

  const PHASE_2_MODULES = ['lead', 'customer', 'deal', 'quotation', 'payment', 'note'];

  it('describes every type in a module Phase 2 writes, except the ones nothing writes yet', () => {
    const undescribed = Object.values(ACTIVITY_TYPES)
      .filter((type) => PHASE_2_MODULES.includes(type.split('.')[0] ?? ''))
      .filter((type) => !hasDescriber(type))
      .filter((type) => !(type in NOT_WRITTEN_YET));
    expect(undescribed, 'these render as a bare row, losing whatever is in their payload').toEqual(
      [],
    );
  });

  it('keeps the deferred list honest: nothing on it has a describer', () => {
    // A type that gained a describer but stayed on this list would make the list a lie, and the
    // list is the only record of what the timeline cannot yet say.
    for (const type of Object.keys(NOT_WRITTEN_YET)) {
      expect(hasDescriber(type), `${type} is described; take it off the deferred list`).toBe(false);
    }
  });
});
