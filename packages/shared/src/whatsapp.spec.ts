import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_STATUSES,
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
