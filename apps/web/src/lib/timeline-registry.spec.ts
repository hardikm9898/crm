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
    // A type that really is unknown: `whatsapp.template_sent` used to stand here and now has a
    // describer, which is exactly the trap "a test that names a model as a hypothetical" warns
    // about — so this names something no phase will ever write.
    const rendered = describeEntry(
      entry({ type: 'whatsapp.carrier_pigeon', module: 'whatsapp', known: false }),
    );
    expect(rendered.label).toBe('Whatsapp');
    expect(rendered.description).toBe('Whatsapp carrier pigeon.');
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
    // Described as of Phase 5 step 2, which is what the deferred list above now records.
    expect(hasDescriber('whatsapp.template_sent')).toBe(true);
    expect(hasDescriber('whatsapp.read')).toBe(false);
  });

  it('prints what somebody typed into a capture form, which is the point of the entry', () => {
    const described = describeEntry(
      entry({
        type: 'lead.form_submitted',
        module: 'lead',
        payload: {
          formName: 'Website enquiry',
          answers: [
            { label: 'What do you need?', value: 'A 3BHK in Baner, possession this year' },
            { label: 'Budget', value: '₹85,00,000' },
          ],
        },
      }),
    );
    expect(described.label).toBe('Form');
    expect(described.description).toContain('Website enquiry');
    expect(described.description).toContain('A 3BHK in Baner');
    expect(described.description).toContain('Budget: ₹85,00,000');
  });

  it('still reads as a sentence when a form asked nothing but a phone number', () => {
    const described = describeEntry(
      entry({ type: 'lead.form_submitted', module: 'lead', payload: { formName: 'Popup' } }),
    );
    expect(described.description).toBe('Filled in Popup.');
  });

  it('describes an enquiry that arrived with no form behind it', () => {
    const described = describeEntry(
      entry({
        type: 'lead.enquiry_received',
        module: 'lead',
        payload: {
          channel: 'api',
          answers: [{ label: 'Message', value: 'Need a 3BHK before Diwali' }],
        },
      }),
    );
    // Its own sentence, not a form submission with an invented form name.
    expect(described.label).toBe('Enquiry');
    expect(described.description).toContain('Api');
    expect(described.description).toContain('Need a 3BHK before Diwali');
    expect(described.description).not.toContain('Filled in');
  });

  it('still reads as a sentence when an enquiry carried no message', () => {
    expect(
      describeEntry(entry({ type: 'lead.enquiry_received', module: 'lead', payload: {} }))
        .description,
    ).toBe('Arrived through an integration.');
  });

  it('ignores an answer whose shape is not what it expects', () => {
    const described = describeEntry(
      entry({
        type: 'lead.form_submitted',
        module: 'lead',
        payload: { formName: 'Website enquiry', answers: [{ label: 'Budget' }, 'nonsense', null] },
      }),
    );
    expect(described.description).toBe('Filled in Website enquiry.');
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

describe('tasks and follow-ups (FR-TSK-1..6)', () => {
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

  it('says what was planned, and when', () => {
    const described = entry('task.created', {
      title: 'Call about the 3BHK',
      taskType: 'Call',
      dueAt: '2026-04-02T09:30:00.000Z',
    });
    expect(described.label).toBe('Planned');
    expect(described.description).toContain('Call about the 3BHK');
    // The due time, not the raw ISO string a programmer would read.
    expect(described.description).not.toContain('2026-04-02T09:30');
  });

  it('reports the outcome, and only calls a positive one a success', () => {
    const good = entry('task.completed', {
      title: 'Call',
      outcome: 'Spoke — interested',
      outcomeIsPositive: true,
    });
    expect(good.description).toContain('Spoke — interested');
    expect(good.tone).toBe('success');

    // "No answer" is not progress, and a timeline where every completion reads green is one
    // nobody can scan for the calls that actually went well.
    const indifferent = entry('task.completed', {
      title: 'Call',
      outcome: 'No answer',
      outcomeIsPositive: null,
    });
    expect(indifferent.tone).toBe('neutral');
  });

  it('mentions the follow-up that was planned in the same breath', () => {
    const described = entry('task.completed', {
      title: 'First call',
      outcome: 'Spoke — interested',
      outcomeIsPositive: true,
      nextFollowUp: { taskId: 'x', title: 'Site visit', dueAt: '2026-04-05T05:00:00.000Z' },
    });
    expect(described.description).toContain('Next: Site visit');
  });

  it('names the reason a follow-up moved, and warns once it has become a habit', () => {
    const once = entry('task.rescheduled', {
      title: 'Call',
      toDueAt: '2026-04-09T09:30:00.000Z',
      reason: 'Customer busy',
      rescheduleCount: 1,
    });
    expect(once.description).toContain('Customer busy');
    expect(once.tone).toBe('neutral');

    const chronic = entry('task.rescheduled', {
      title: 'Call',
      toDueAt: '2026-04-09T09:30:00.000Z',
      reason: 'Customer busy',
      rescheduleCount: 4,
    });
    // `FR-TSK-5` calls chronic rescheduling a coaching signal, so the row has to carry it.
    expect(chronic.description).toContain('Moved 4 times');
    expect(chronic.tone).toBe('warning');
  });

  it('reads a miss as a miss', () => {
    const described = entry('task.overdue', {
      title: 'Call back',
      dueAt: '2026-04-01T09:30:00.000Z',
    });
    expect(described.label).toBe('Missed');
    expect(described.tone).toBe('danger');
  });

  it('still reads when the payload is empty', () => {
    for (const type of [
      'task.created',
      'task.completed',
      'task.rescheduled',
      'task.cancelled',
      'task.overdue',
    ]) {
      expect(entry(type, {}).description.length).toBeGreaterThan(5);
    }
  });
});

describe('SLA (FR-TSK-8)', () => {
  const entry = (type: string, payload: Record<string, unknown>) =>
    describeEntry({
      id: 'a',
      type,
      module: type.split('.')[0]!,
      known: true,
      occurredAt: '2026-10-07T06:00:00.000Z',
      visibility: 'all',
      actor: { type: 'system', id: null, name: null },
      payload,
    });

  it('names the promise a business owner recognises, not the clock', () => {
    const described = entry('sla.breached', {
      target: 'first_response',
      policy: 'First response within an hour',
      targetMinutes: 60,
      dueAt: '2026-10-07T05:00:00.000Z',
    });
    expect(described.description).toContain('First response within an hour');
    // `first_response` is a column name; nobody outside this repository reads it.
    expect(described.description).not.toContain('first_response');
    expect(described.description).toContain('60 working minutes');
    expect(described.tone).toBe('danger');
  });

  it('warns before it blames', () => {
    const described = entry('sla.at_risk', {
      target: 'first_response',
      policy: 'First response within an hour',
      dueAt: '2026-10-07T07:00:00.000Z',
    });
    expect(described.label).toBe('Running out');
    expect(described.tone).toBe('warning');
    expect(described.description).toContain('nearly out of time');
  });

  it('spells out every target, and falls back rather than printing a slug', () => {
    for (const [target, expected] of [
      ['first_response', 'The first response'],
      ['next_response', 'The next reply'],
      ['resolution', 'Closing this out'],
      ['something_new', 'The response'],
    ] as const) {
      expect(entry('sla.breached', { target }).description).toContain(expected);
    }
  });

  it('still reads when the payload is empty', () => {
    for (const type of ['sla.at_risk', 'sla.breached']) {
      expect(entry(type, {}).description.length).toBeGreaterThan(10);
    }
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
    'mention.created': 3,
    'document.uploaded': 3,
    'consent.granted': 13,
    'consent.revoked': 13,
    // An *inbound* call nobody answered. Only a telephony provider can report one — the manual
    // driver never learns that a call came in at all — so nothing writes it until Phase 4.
    'call.missed': 4,
    /**
     * The one WhatsApp type nothing writes to the timeline, and deliberately.
     *
     * A read receipt is on the message in the thread, where somebody looking at that message is
     * already looking; a timeline with four rows per message — queued, sent, delivered, read — is
     * a timeline a business owner scrolls past. Step 2 writes `sent`, `template_sent` and `failed`,
     * which are the three a person would want to see on a lead.
     */
    'whatsapp.read': 5,
  };

  // Phase 3 step 1 added `task`, and took the five task types off the deferred list above as part
  // of the same change — which is what the second test in this block is for.
  const WRITTEN_MODULES = [
    'lead',
    'customer',
    'deal',
    'quotation',
    'payment',
    'note',
    'task',
    'sla',
    'call',
    'whatsapp',
  ];

  it('describes every type in a module the product writes, except the ones nothing writes yet', () => {
    const undescribed = Object.values(ACTIVITY_TYPES)
      .filter((type) => WRITTEN_MODULES.includes(type.split('.')[0] ?? ''))
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

describe('a whatsapp message on the timeline (`FR-WA-3`)', () => {
  it('says who messaged and what they said', () => {
    const rendered = describeEntry(
      entry({
        type: 'whatsapp.received',
        module: 'whatsapp',
        payload: {
          conversationId: 'c1',
          messageId: 'm1',
          preview: 'Is the 3BHK still available?',
          messageType: 'text',
          from: '+919845012345',
          profileName: 'Asha Rao',
        },
      }),
    );
    expect(rendered.label).toBe('WhatsApp');
    expect(rendered.description).toContain('Asha Rao');
    // The words themselves: an entry that only says a message arrived sends the reader elsewhere
    // to find out what it said.
    expect(rendered.description).toContain('Is the 3BHK still available?');
    expect(rendered.tone).toBe('warning');
  });

  it('falls back to the number when WhatsApp sent no profile name, and carries the media sentence', () => {
    const rendered = describeEntry(
      entry({
        type: 'whatsapp.received',
        module: 'whatsapp',
        payload: {
          conversationId: 'c1',
          messageId: 'm2',
          // What `describeMessagePreview` answers for an image with no caption — never "[image]",
          // which would be indistinguishable from somebody typing it.
          preview: 'Sent a photo',
          messageType: 'image',
          from: '+919845012345',
          profileName: null,
        },
      }),
    );
    expect(rendered.description).toContain('+919845012345');
    expect(rendered.description).toContain('Sent a photo');
  });
});

describe('a call on the timeline (`FR-CALL-1..3`)', () => {
  it('shows the attempt as a question, not as a success', () => {
    // With the manual driver the product hands the number to a phone and never learns the result.
    // An attempt that reads as "called them" would make a lead with four unanswered rings look
    // worked, which is the opposite of what a manager needs to see.
    const rendered = describeEntry(
      entry({
        type: 'call.attempted',
        module: 'call',
        payload: { callId: 'c1', toE164: '+919845012345', via: 'manual' },
      }),
    );
    expect(rendered.label).toBe('Dialled');
    expect(rendered.description).toContain('+919845012345');
    expect(rendered.description).toMatch(/no outcome recorded/i);
    expect(rendered.tone).toBe('warning');
  });

  it('names the outcome in the tenant’s own words, with the length and the note', () => {
    const rendered = describeEntry(
      entry({
        type: 'call.logged',
        module: 'call',
        payload: {
          outcome: 'Spoke — interested',
          outcomeCategory: 'connected',
          reached: true,
          durationSeconds: 252,
          note: 'Wants a site visit on Saturday',
        },
      }),
    );
    expect(rendered.label).toBe('Spoke');
    expect(rendered.description).toContain('Spoke — interested');
    expect(rendered.description).toContain('4 min 12 sec');
    expect(rendered.description).toContain('Wants a site visit on Saturday');
    expect(rendered.tone).toBe('success');
  });

  it('only tones a call that reached somebody as a success', () => {
    // A timeline where every logged call reads as success is one nobody can scan for the calls
    // that went well — the same rule the task outcomes follow.
    const rendered = describeEntry(
      entry({
        type: 'call.logged',
        module: 'call',
        payload: { outcome: 'No answer', outcomeCategory: 'no_answer', reached: false },
      }),
    );
    expect(rendered.tone).toBe('neutral');
    expect(rendered.label).toBe('Call');
  });

  it('leaves the length out of a call that had none, rather than saying "0 sec"', () => {
    const rendered = describeEntry(
      entry({
        type: 'call.logged',
        module: 'call',
        payload: { outcome: 'Line busy', outcomeCategory: 'busy', durationSeconds: 0 },
      }),
    );
    expect(rendered.description).toBe('Line busy.');
  });

  it('still reads when the payload is empty', () => {
    const rendered = describeEntry(entry({ type: 'call.logged', module: 'call', payload: {} }));
    expect(rendered.description).toBe('A call.');
  });
});

describe('a reply, a template and a refusal on the timeline (`FR-WA-4`, `FR-WA-9`)', () => {
  it('reads a reply as what was said, not as a type', () => {
    const rendered = describeEntry(
      entry({
        type: 'whatsapp.sent',
        module: 'whatsapp',
        payload: {
          conversationId: 'c1',
          messageId: 'm1',
          preview: 'It is — would Saturday suit?',
          messageType: 'text',
        },
      }),
    );
    expect(rendered.label).toBe('Replied');
    expect(rendered.description).toContain('It is — would Saturday suit?');
  });

  it('tells a template apart from a reply somebody typed', () => {
    const rendered = describeEntry(
      entry({
        type: 'whatsapp.template_sent',
        module: 'whatsapp',
        payload: { messageId: 'm2', preview: 'Hello Asha, your visit is confirmed.', messageType: 'template' },
      }),
    );
    expect(rendered.label).toBe('Template sent');
    expect(rendered.description).toMatch(/template/i);
    expect(rendered.description).toContain('Hello Asha');
  });

  it('carries WhatsApp’s own reason for a refusal, in red', () => {
    const rendered = describeEntry(
      entry({
        type: 'whatsapp.failed',
        module: 'whatsapp',
        payload: {
          messageId: 'm3',
          errorCode: '131047',
          reason: 'More than 24 hours have passed since the recipient last replied to this number.',
        },
      }),
    );
    expect(rendered.label).toBe('Not delivered');
    expect(rendered.description).toContain('More than 24 hours');
    expect(rendered.tone).toBe('danger');
  });

  it('still reads as a sentence when WhatsApp said nothing', () => {
    const rendered = describeEntry(
      entry({ type: 'whatsapp.failed', module: 'whatsapp', payload: { messageId: 'm4' } }),
    );
    expect(rendered.description).toMatch(/did not say why/i);
  });
});
