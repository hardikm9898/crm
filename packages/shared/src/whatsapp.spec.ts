import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_STATUSES,
  MESSAGE_STATUS_ORDER,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATUSES,
  parseWhatsAppStatuses,
  renderTemplate,
  sendingAllowed,
  statusAdvances,
  statusesBeatenBy,
  templateBlockedReason,
  templateIsSendable,
  templateProblems,
  templateVariables,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  SERVICE_WINDOW_HOURS,
  SUPPORTED_INBOUND_TYPES,
  describeMessagePreview,
  describeWindow,
  parseWhatsAppMessages,
  waIdToE164,
  windowExpiryFrom,
  windowIsOpen,
} from './index.js';

/** One `messages` delivery, as Meta sends it. */
function delivery(messages: unknown[], over: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102938475610293',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919845000000', phone_number_id: '55667788' },
              contacts: [{ wa_id: '919845012345', profile: { name: 'Asha Rao' } }],
              messages,
              ...over,
            },
          },
        ],
      },
    ],
  };
}

const text = (over: Record<string, unknown> = {}) => ({
  from: '919845012345',
  id: 'wamid.HBgMOTE5ODQ1MDEyMzQ1',
  timestamp: '1792400000',
  type: 'text',
  text: { body: 'Is the 3BHK still available?' },
  ...over,
});

describe('the vocabulary', () => {
  it('names every type the schema allows, and says which it can store the content of', () => {
    expect(MESSAGE_TYPES).toContain('text');
    expect(MESSAGE_TYPES).toContain('system');
    // The supported list is a subset, and saying so out loud is what keeps "we store photos" from
    // being assumed: media arrives with its own step.
    for (const type of SUPPORTED_INBOUND_TYPES) {
      expect(MESSAGE_TYPES, type).toContain(type);
    }
    expect(SUPPORTED_INBOUND_TYPES).not.toContain('image');
  });

  it('orders the statuses the way Meta transitions them', () => {
    expect([...MESSAGE_STATUSES]).toEqual([
      'queued',
      'accepted',
      'sent',
      'delivered',
      'read',
      'failed',
    ]);
    expect([...CONVERSATION_STATUSES]).toEqual(['open', 'pending', 'snoozed', 'closed']);
  });
});

describe('the 24-hour service window', () => {
  const inbound = new Date('2026-10-19T08:00:00.000Z');

  it('closes exactly 24 hours after the customer’s last message', () => {
    expect(SERVICE_WINDOW_HOURS).toBe(24);
    expect(windowExpiryFrom(inbound).toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('is shut for a conversation nobody has ever messaged from', () => {
    // Not "open because we have no evidence it is closed": a business that has never been
    // messaged may only start with a template, and treating null as open would send a free-form
    // message Meta refuses — or worse, accepts and bills as marketing.
    expect(windowIsOpen(null, inbound)).toBe(false);
    expect(describeWindow(null, inbound)).toMatch(/never messaged/i);
  });

  it('is shut the instant it expires, not a moment after', () => {
    const expiry = windowExpiryFrom(inbound);
    expect(windowIsOpen(expiry, new Date(expiry.getTime() - 1))).toBe(true);
    expect(windowIsOpen(expiry, expiry)).toBe(false);
    expect(windowIsOpen(expiry, new Date(expiry.getTime() + 1))).toBe(false);
  });

  it('counts down in words, rounded down, and counts to one properly', () => {
    const expiry = windowExpiryFrom(inbound);
    const at = (minutesLeft: number) => new Date(expiry.getTime() - minutesLeft * 60_000);
    expect(describeWindow(expiry, at(90))).toBe('1 hour left to reply freely.');
    expect(describeWindow(expiry, at(200))).toBe('3 hours left to reply freely.');
    expect(describeWindow(expiry, at(59))).toBe('59 minutes left to reply freely.');
    expect(describeWindow(expiry, at(1))).toBe('1 minute left to reply freely.');
    // Rounded down on purpose: "1 hour left" that refuses the send a minute later is worse than
    // "59 minutes".
    expect(describeWindow(expiry, at(119))).toBe('1 hour left to reply freely.');
    expect(describeWindow(expiry, at(0))).toMatch(/closed/i);
  });
});

describe('reading a delivery', () => {
  it('finds the message, who sent it, and what WhatsApp calls them', () => {
    const [message] = parseWhatsAppMessages(delivery([text()]));
    expect(message?.providerMessageId).toBe('wamid.HBgMOTE5ODQ1MDEyMzQ1');
    expect(message?.phoneNumberId).toBe('55667788');
    expect(message?.fromWaId).toBe('919845012345');
    expect(message?.profileName).toBe('Asha Rao');
    expect(message?.type).toBe('text');
    expect(message?.body).toBe('Is the 3BHK still available?');
    // Meta sends seconds, as a string. A `new Date('1792400000')` would be Invalid Date and every
    // message would land at the moment we happened to process it.
    expect(message?.occurredAt.toISOString()).toBe('2026-10-19T08:53:20.000Z');
  });

  it('returns every message in a batch, each on its own id', () => {
    const messages = parseWhatsAppMessages(
      delivery([text({ id: 'wamid.one' }), text({ id: 'wamid.two', text: { body: 'And the 2BHK?' } })]),
    );
    expect(messages.map((message) => message.providerMessageId)).toEqual(['wamid.one', 'wamid.two']);
    expect(messages[1]?.body).toBe('And the 2BHK?');
  });

  it('keeps a message whose content it cannot store, rather than dropping it', () => {
    // A conversation that silently skips a photo reads as a message nobody sent.
    const [message] = parseWhatsAppMessages(
      delivery([text({ type: 'image', text: undefined, image: { id: 'media-1', mime_type: 'image/jpeg' } })]),
    );
    expect(message?.type).toBe('image');
    expect(message?.body).toBeNull();
    expect((message?.raw as { image?: { id?: string } }).image?.id).toBe('media-1');
    expect(describeMessagePreview('image', null)).toBe('Sent a photo');
  });

  it('keeps a caption, because a caption is text about the photo', () => {
    const [message] = parseWhatsAppMessages(
      delivery([text({ type: 'image', text: undefined, image: { id: 'm', caption: 'Our kitchen' } })]),
    );
    expect(message?.body).toBe('Our kitchen');
    expect(describeMessagePreview('image', 'Our kitchen')).toBe('Our kitchen');
  });

  it('stores a type nobody has heard of as `system`, with the payload intact', () => {
    const [message] = parseWhatsAppMessages(
      delivery([text({ type: 'order', text: undefined, order: { catalog_id: 'c1' } })]),
    );
    expect(message?.type).toBe('system');
    expect((message?.raw as { order?: unknown }).order).toEqual({ catalog_id: 'c1' });
  });

  it('reads the readable part of a button, a list, a location and a reaction', () => {
    const read = (over: Record<string, unknown>) =>
      parseWhatsAppMessages(delivery([text({ text: undefined, ...over })]))[0];

    expect(
      read({ type: 'interactive', interactive: { button_reply: { id: 'b', title: 'Book a visit' } } })?.body,
    ).toBe('Book a visit');
    expect(
      read({ type: 'interactive', interactive: { list_reply: { id: 'l', title: 'Weekends' } } })?.body,
    ).toBe('Weekends');
    expect(read({ type: 'location', location: { latitude: 12.9, longitude: 77.6, name: 'Indiranagar' } })?.body).toBe(
      'Indiranagar',
    );
    expect(read({ type: 'reaction', reaction: { message_id: 'wamid.one', emoji: '👍' } })?.body).toBe('👍');
    // A reaction names its subject under its own key rather than in `context`.
    expect(
      read({ type: 'reaction', reaction: { message_id: 'wamid.one', emoji: '👍' } })?.replyToProviderId,
    ).toBe('wamid.one');
    expect(read({ type: 'text', text: { body: 'hi' }, context: { id: 'wamid.zero' } })?.replyToProviderId).toBe(
      'wamid.zero',
    );
  });

  it('ignores everything that is not a message, without throwing', () => {
    // Meta sends statuses for messages we sent, and fields nobody subscribed to. Both arrive at
    // the same endpoint, and a parser that threw would make Meta disable it.
    expect(parseWhatsAppMessages(delivery([], { messages: undefined, statuses: [{ id: 'wamid.x' }] }))).toEqual([]);
    expect(parseWhatsAppMessages({ entry: [{ changes: [{ field: 'account_update', value: {} }] }] })).toEqual([]);
    expect(parseWhatsAppMessages({})).toEqual([]);
    expect(parseWhatsAppMessages({ entry: 'nonsense' })).toEqual([]);
    // No `phone_number_id` means nothing can say which business number it arrived at.
    expect(parseWhatsAppMessages(delivery([text()], { metadata: {} }))).toEqual([]);
    // A message with no id could not be deduplicated, which is the one guarantee this phase has.
    expect(parseWhatsAppMessages(delivery([text({ id: undefined })]))).toEqual([]);
  });

  it('turns Meta’s wa_id into E.164 by adding a plus and nothing else', () => {
    expect(waIdToE164('919845012345')).toBe('+919845012345');
    expect(waIdToE164('+91 98450 12345')).toBe('+919845012345');
    // Too short or too long to be a number, so refused rather than stored as one.
    expect(waIdToE164('1234')).toBeNull();
    expect(waIdToE164('9198450123456789012')).toBeNull();
  });
});

describe('what may be sent, and when (`FR-WA-1`)', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');

  it('allows free text only while the window is open', () => {
    const open = new Date('2026-10-19T18:00:00.000Z');
    expect(sendingAllowed({ windowExpiresAt: open, kind: 'text', now })).toEqual({ allowed: true });
    const closed = new Date('2026-10-19T06:00:00.000Z');
    const refusal = sendingAllowed({ windowExpiresAt: closed, kind: 'text', now });
    expect(refusal.allowed).toBe(false);
    if (refusal.allowed === false) {
      expect(refusal.code).toBe('OUTSIDE_SERVICE_WINDOW');
      // The sentence says what to do instead, because a refusal that only says no is a dead end.
      expect(refusal.message).toMatch(/template/i);
    }
  });

  it('allows a template at any time, including to somebody who has never written', () => {
    expect(sendingAllowed({ windowExpiresAt: null, kind: 'template', now })).toEqual({
      allowed: true,
    });
    const first = sendingAllowed({ windowExpiresAt: null, kind: 'text', now });
    expect(first.allowed).toBe(false);
    if (first.allowed === false) expect(first.message).toMatch(/never messaged/i);
  });
});

describe('a template', () => {
  const components = { header: 'Rao Interiors', body: 'Hello {{1}}, your {{2}} is ready.', footer: 'Reply STOP to opt out' };

  it('finds its variables in order, without repeats', () => {
    expect(templateVariables(components.body)).toEqual([1, 2]);
    expect(templateVariables('{{2}} then {{1}} then {{1}} again')).toEqual([1, 2]);
    expect(templateVariables('nothing to fill in')).toEqual([]);
    // Meta's own spacing tolerance.
    expect(templateVariables('{{ 1 }}')).toEqual([1]);
  });

  it('refuses a name, a language or a gap Meta would refuse hours later', () => {
    const problems = templateProblems({
      name: 'Order Update',
      language: 'english',
      category: 'promotional',
      components: { body: 'Hello {{1}} and {{3}}' },
      variableMap: { '1': 'lead.fullName' },
    });
    const codes = problems.map((problem) => problem.code);
    expect(codes).toContain('INVALID_TEMPLATE_NAME');
    expect(codes).toContain('INVALID_LANGUAGE');
    expect(codes).toContain('INVALID_CATEGORY');
    // A jump from {{1}} to {{3}} is what Meta rejects, and nothing else would have said so.
    expect(codes).toContain('VARIABLE_GAP');
    // And a variable nothing fills would send "undefined" to a customer.
    expect(problems.some((problem) => problem.field === 'variableMap.3')).toBe(true);
  });

  it('accepts a template whose variables are all mapped', () => {
    expect(
      templateProblems({
        name: 'order_update',
        language: 'en_US',
        category: 'utility',
        components,
        variableMap: { '1': 'lead.fullName', '2': 'custom.order' },
      }),
    ).toEqual([]);
  });

  it('refuses a variable in the header rather than guessing at Meta’s numbering', () => {
    const problems = templateProblems({
      name: 'order_update',
      language: 'en',
      category: 'utility',
      components: { header: 'Hello {{1}}', body: 'Your order is ready.' },
    });
    expect(problems.map((problem) => problem.code)).toContain('HEADER_VARIABLE_UNSUPPORTED');
  });

  it('renders with the values filled in, and names what is missing instead of sending a blank', () => {
    const rendered = renderTemplate(components, { '1': 'Asha', '2': 'sofa' });
    expect(rendered.text).toContain('Hello Asha, your sofa is ready.');
    // The header and the footer travel with it, because that is what the customer will read.
    expect(rendered.text).toContain('Rao Interiors');
    expect(rendered.text).toContain('Reply STOP');
    expect(rendered.values).toEqual(['Asha', 'sofa']);
    expect(rendered.missing).toEqual([]);

    // A blank is missing, not empty: "Hi  , your order…" is worse than a refusal.
    const blank = renderTemplate(components, { '1': 'Asha', '2': '   ' });
    expect(blank.missing).toEqual(['2']);
    const absent = renderTemplate(components, { '1': 'Asha' });
    expect(absent.missing).toEqual(['2']);
    // And the preview still shows the placeholder, so a person can see which one is empty.
    expect(absent.text).toContain('{{2}}');
  });

  it('says why an unapproved template cannot be sent, for every status it has', () => {
    for (const status of WHATSAPP_TEMPLATE_STATUSES) {
      const blocked = templateBlockedReason(status);
      expect(templateIsSendable(status)).toBe(status === 'approved');
      if (status === 'approved') expect(blocked).toBeNull();
      else expect((blocked ?? '').length, status).toBeGreaterThan(20);
    }
    expect(WHATSAPP_TEMPLATE_CATEGORIES).toContain('marketing');
  });
});

describe('status receipts (`FR-WA-4`)', () => {
  const statuses = (rows: unknown[]) => ({
    entry: [
      {
        id: '102938475610293',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919845000000', phone_number_id: '55667788' },
              statuses: rows,
            },
          },
        ],
      },
    ],
  });

  it('reads Meta’s four transitions and ignores a word it does not model', () => {
    const parsed = parseWhatsAppStatuses(
      statuses([
        { id: 'wamid.a', status: 'sent', timestamp: '1792400000', recipient_id: '919845012345' },
        { id: 'wamid.a', status: 'delivered', timestamp: '1792400060' },
        { id: 'wamid.a', status: 'read', timestamp: '1792400120' },
        { id: 'wamid.b', status: 'deleted', timestamp: '1792400180' },
        { id: 'wamid.c', status: 'sent' },
      ]),
    );
    expect(parsed.map((row) => row.status)).toEqual(['sent', 'delivered', 'read', 'sent']);
    expect(parsed[0]?.phoneNumberId).toBe('55667788');
    expect(parsed[0]?.recipientWaId).toBe('919845012345');
    expect(parsed[0]?.occurredAt.toISOString()).toBe('2026-10-19T08:53:20.000Z');
    // No timestamp: our own clock, rather than dropping a transition that happened.
    expect(parsed[3]?.occurredAt).toBeInstanceOf(Date);
  });

  it('keeps Meta’s own sentence for a failure, preferring the detail to the title', () => {
    const [failure] = parseWhatsAppStatuses(
      statuses([
        {
          id: 'wamid.a',
          status: 'failed',
          timestamp: '1792400000',
          errors: [
            {
              code: 131047,
              title: 'Re-engagement message',
              message: 'Message failed to send.',
              error_data: {
                details:
                  'More than 24 hours have passed since the recipient last replied to this number.',
              },
            },
          ],
        },
      ]),
    );
    expect(failure?.errorCode).toBe('131047');
    // The details, not the title: it is the sentence an agent can act on.
    expect(failure?.errorMessage).toMatch(/More than 24 hours/);
  });

  it('records what Meta charged the conversation as', () => {
    const [sent] = parseWhatsAppStatuses(
      statuses([
        {
          id: 'wamid.a',
          status: 'sent',
          timestamp: '1792400000',
          conversation: { id: 'c1', origin: { type: 'service' } },
          pricing: { billable: true, category: 'service' },
        },
      ]),
    );
    expect(sent?.conversationCategory).toBe('service');
    expect(sent?.billable).toBe(true);
  });

  it('never lets a status go backwards, because Meta’s receipts arrive out of order', () => {
    expect(statusAdvances('sent', 'delivered')).toBe(true);
    expect(statusAdvances('delivered', 'read')).toBe(true);
    // The one that matters: a late `delivered` must not undo `read`.
    expect(statusAdvances('read', 'delivered')).toBe(false);
    expect(statusAdvances('read', 'read')).toBe(false);
    // A failure is the end, whenever it arrives — and nothing follows it.
    expect(statusAdvances('read', 'failed')).toBe(true);
    expect(statusAdvances('failed', 'read')).toBe(false);
    expect(statusAdvances('failed', 'failed')).toBe(false);
    // The order a message actually travels in.
    expect(MESSAGE_STATUS_ORDER.slice(0, 3)).toEqual(['queued', 'accepted', 'sent']);
  });

  it('ignores a delivery with no statuses at all', () => {
    expect(parseWhatsAppStatuses({})).toEqual([]);
    expect(parseWhatsAppStatuses(statuses([]))).toEqual([]);
    expect(parseWhatsAppStatuses({ entry: [{ changes: [{ field: 'account_update', value: {} }] }] })).toEqual([]);
  });
});

describe('the statuses one receipt may overwrite', () => {
  it('lists exactly what the ordering allows, for an atomic update', () => {
    // The `UPDATE … WHERE status IN (…)` form of `statusAdvances`, because a read-then-write loses
    // the race when three receipts for one message are processed at once.
    expect(statusesBeatenBy('delivered')).toEqual(['queued', 'accepted', 'sent']);
    expect(statusesBeatenBy('read')).toEqual(['queued', 'accepted', 'sent', 'delivered']);
    expect(statusesBeatenBy('sent')).toEqual(['queued', 'accepted']);
    // A failure is the end, from wherever it arrives — and nothing overwrites one.
    expect(statusesBeatenBy('failed')).toEqual(['queued', 'accepted', 'sent', 'delivered', 'read']);
    for (const next of MESSAGE_STATUSES) {
      for (const current of statusesBeatenBy(next)) {
        expect(statusAdvances(current, next), `${current} → ${next}`).toBe(true);
      }
    }
  });
});
