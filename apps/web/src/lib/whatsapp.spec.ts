import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_STATUSES as API_CONVERSATION_STATUSES,
  WHATSAPP_TEMPLATE_CATEGORIES as API_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATUSES as API_TEMPLATE_STATUSES,
  TEMPLATE_VARIABLE_SOURCES as API_VARIABLE_SOURCES,
  MESSAGE_DIRECTIONS as API_MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES as API_MESSAGE_STATUSES,
  MESSAGE_TYPES as API_MESSAGE_TYPES,
} from '@leados/shared';
import {
  CONVERSATION_STATUSES,
  TEMPLATE_CATEGORY_LABELS,
  TEMPLATE_STATUS_LABELS,
  TEMPLATE_STATUS_TONES,
  TEMPLATE_VARIABLE_SOURCES,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATUSES,
  attachmentHref,
  attachmentName,
  describeConversationState,
  snoozeChoices,
  attachmentShape,
  attachmentWaiting,
  describeSize,
  needsAttention,
  templateVariables,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  STATUS_LABELS,
  STATUS_WORDS,
  conversationQuery,
  conversationTitle,
  isConversationStatus,
  messageStanding,
  type ConversationMessage,
  type ConversationSummary,
  type MessageMedia,
} from './whatsapp';

const conversation = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'c1',
  channel: 'whatsapp',
  contact: '+919845012345',
  number: { id: 'n1', displayPhoneE164: '+919845000000', verifiedName: 'Rao Interiors' },
  lead: { id: 'l1', fullName: 'Asha Rao' },
  assignedTo: null,
  status: 'open',
  unreadCount: 2,
  lastMessageAt: '2026-10-19T09:00:00.000Z',
  lastInboundAt: '2026-10-19T09:00:00.000Z',
  lastOutboundAt: null,
  windowExpiresAt: '2026-10-20T09:00:00.000Z',
  windowIsOpen: true,
  windowSummary: 'You can reply freely for another 23 hours',
  tags: [],
  lockedBy: null,
  lock: { held: false, mine: false, expiresAt: null, message: null },
  snoozedUntil: null,
  lastMessage: {
    direction: 'inbound',
    type: 'text',
    preview: 'Is the 3BHK still available?',
    createdAt: '2026-10-19T09:00:00.000Z',
  },
  createdAt: '2026-10-19T09:00:00.000Z',
  ...over,
});

const message = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  direction: 'outbound',
  type: 'text',
  body: 'It is — would Saturday suit?',
  preview: 'It is — would Saturday suit?',
  status: 'sent',
  errorCode: null,
  errorMessage: null,
  providerMessageId: 'wamid.abc',
  replyToProviderId: null,
  sender: { id: 'u1', name: 'Nikhil' },
  createdAt: '2026-10-19T09:05:00.000Z',
  media: null,
  ...over,
});

const attachment = (over: Partial<MessageMedia> = {}): MessageMedia => ({
  id: 'md1',
  fileName: 'floor-plan.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1536,
  downloadStatus: 'stored',
  reason: null,
  voice: false,
  available: true,
  ...over,
});

describe('the WhatsApp vocabulary', () => {
  it('matches the API’s, which this file deliberately does not import at runtime', () => {
    // `@leados/shared`'s entry point reaches `node:async_hooks` through the tenant context, and a
    // client component that pulls that in fails the Next build. So each list is declared twice and
    // reconciled here, in a spec that runs in Node and may import both.
    expect([...CONVERSATION_STATUSES]).toEqual([...API_CONVERSATION_STATUSES]);
    expect([...MESSAGE_DIRECTIONS]).toEqual([...API_MESSAGE_DIRECTIONS]);
    expect([...MESSAGE_STATUSES]).toEqual([...API_MESSAGE_STATUSES]);
    expect([...MESSAGE_TYPES]).toEqual([...API_MESSAGE_TYPES]);
    // Phase 5 step 2's half of the same vocabulary.
    expect([...WHATSAPP_TEMPLATE_CATEGORIES]).toEqual([...API_TEMPLATE_CATEGORIES]);
    expect([...WHATSAPP_TEMPLATE_STATUSES]).toEqual([...API_TEMPLATE_STATUSES]);
    expect(TEMPLATE_VARIABLE_SOURCES.map((source) => source.key)).toEqual(
      API_VARIABLE_SOURCES.map((source) => source.key),
    );
  });

  it('has a word for every status, and none of them is a column name', () => {
    for (const status of CONVERSATION_STATUSES) {
      expect(STATUS_LABELS[status], status).toBeTruthy();
      expect(STATUS_LABELS[status], status).not.toMatch(/_/);
    }
    for (const status of MESSAGE_STATUSES) {
      expect(STATUS_WORDS[status], status).toBeTruthy();
      expect(STATUS_WORDS[status], status).not.toMatch(/_/);
    }
  });

  it('accepts only a status the API would', () => {
    expect(isConversationStatus('open')).toBe(true);
    expect(isConversationStatus('archived')).toBe(false);
  });
});

describe('the inbox query', () => {
  it('keeps an absent assignment absent, rather than folding it to “unassigned”', () => {
    // Absent means everybody's. Folding it would show an agent a fraction of their inbox and look
    // like missing messages — the `?flag=true` trap, with a word as the third value.
    expect(conversationQuery({})).toBe('?limit=25');
    expect(conversationQuery({ assigned: '' })).toBe('?limit=25');
    expect(conversationQuery({ assigned: 'me' })).toBe('?assigned=me&limit=25');
    expect(conversationQuery({ assigned: 'everyone' })).toBe('?limit=25');
  });

  it('passes a three-way unread filter through as the API’s own words', () => {
    expect(conversationQuery({ unread: 'true' })).toContain('unread=true');
    expect(conversationQuery({ unread: 'false' })).toContain('unread=false');
    expect(conversationQuery({ unread: 'maybe' })).not.toContain('unread');
  });

  it('drops a status the API does not have, and trims a search term', () => {
    expect(conversationQuery({ status: 'archived' })).not.toContain('status');
    expect(conversationQuery({ status: 'closed' })).toContain('status=closed');
    expect(conversationQuery({ q: '  parking  ' })).toContain('q=parking');
    expect(conversationQuery({ q: '   ' })).not.toContain('q=');
  });
});

describe('what a row says', () => {
  it('heads a conversation with the person, then the number, then an honest fallback', () => {
    expect(conversationTitle(conversation())).toBe('Asha Rao');
    expect(conversationTitle(conversation({ lead: null }))).toBe('+919845012345');
    expect(conversationTitle(conversation({ lead: null, contact: null }))).toBe('Unknown number');
    // A lead whose name is blank is not a title.
    expect(conversationTitle(conversation({ lead: { id: 'l1', fullName: '  ' } }))).toBe(
      '+919845012345',
    );
  });

  it('says nothing about an inbound message’s standing, and the error for a failed one', () => {
    // "Delivered" under a customer's own words is noise: it is in our hands by definition.
    expect(messageStanding(message({ direction: 'inbound', status: 'delivered' }))).toBeNull();
    expect(messageStanding(message({ status: 'read' }))).toBe('Read');
    expect(
      messageStanding(
        message({
          status: 'failed',
          errorCode: '131047',
          errorMessage: 'More than 24 hours since the customer last replied',
        }),
      ),
    ).toBe('More than 24 hours since the customer last replied');
    // A failure Meta did not explain still has to read as a failure.
    expect(messageStanding(message({ status: 'failed' }))).toBe('Not delivered');
  });
});

describe('what a template screen says', () => {
  it('has a word and a colour for every standing, and none of them is a column name', () => {
    for (const status of WHATSAPP_TEMPLATE_STATUSES) {
      expect(TEMPLATE_STATUS_LABELS[status], status).toBeTruthy();
      expect(TEMPLATE_STATUS_LABELS[status], status).not.toMatch(/_/);
      expect(TEMPLATE_STATUS_TONES[status], status).toBeTruthy();
    }
    // Only `approved` reads as good news, because only an approved template can be sent.
    expect(TEMPLATE_STATUS_TONES.approved).toBe('success');
    expect(TEMPLATE_STATUS_TONES.rejected).toBe('danger');
  });

  it('says what each category means, rather than naming it', () => {
    for (const category of WHATSAPP_TEMPLATE_CATEGORIES) {
      expect(TEMPLATE_CATEGORY_LABELS[category], category).toContain('—');
    }
    // The one that needs consent says so where somebody chooses it.
    expect(TEMPLATE_CATEGORY_LABELS.marketing).toMatch(/consent/i);
  });

  it('finds the variables a body asks for, in order', () => {
    expect(templateVariables('Hello {{1}}, your {{2}} is ready')).toEqual([1, 2]);
    expect(templateVariables('{{2}} before {{1}}')).toEqual([1, 2]);
    expect(templateVariables('nothing here')).toEqual([]);
  });

  it('marks only a failed outbound message as needing attention', () => {
    expect(needsAttention(message({ status: 'failed' }))).toBe(true);
    expect(needsAttention(message({ status: 'queued' }))).toBe(false);
    // A message they sent is not ours to retry.
    expect(needsAttention(message({ direction: 'inbound', status: 'failed' }))).toBe(false);
  });
});

describe('an attachment on the thread (`FR-WA-3`)', () => {
  it('renders a photo where it is, and anything else as a link', () => {
    expect(attachmentShape(attachment({ mimeType: 'image/png' }))).toBe('image');
    expect(attachmentShape(attachment())).toBe('download');
    // A sticker is a webp image, which is still something to look at.
    expect(attachmentShape(attachment({ mimeType: 'image/webp' }))).toBe('image');
  });

  it('says so rather than rendering a broken image, for a file that is not here', () => {
    // An `<img>` whose bytes 422 is a broken image with no explanation, which is the one outcome
    // worse than a sentence.
    for (const status of ['pending', 'refused', 'failed']) {
      expect(
        attachmentShape(attachment({ mimeType: 'image/png', available: false, downloadStatus: status })),
      ).toBe('unavailable');
    }
  });

  it('prints the API’s own reason, and never paraphrases it away', () => {
    const refused = attachment({
      available: false,
      downloadStatus: 'refused',
      reason: 'That is 40 MB, and the limit for an image is 5 MB.',
    });
    expect(attachmentWaiting(refused)).toBe('That is 40 MB, and the limit for an image is 5 MB.');
    // Only when the API sent nothing — the `ERROR_FALLBACKS` rule, one layer in.
    expect(attachmentWaiting(attachment({ available: false, downloadStatus: 'pending', reason: null }))).toMatch(
      /still being fetched/,
    );
    expect(
      attachmentWaiting(attachment({ available: false, downloadStatus: 'failed', reason: '  ' })),
    ).toBe('That file is not available.');
  });

  it('never prints an empty name', () => {
    expect(attachmentName(attachment())).toBe('floor-plan.pdf');
    expect(attachmentName(attachment({ fileName: '   ' }))).toBe('Attachment');
    // A voice note is a different thing from an audio file somebody attached.
    expect(attachmentName(attachment({ fileName: null, voice: true }))).toBe('Voice note');
  });

  it('asks this app for the bytes, not the API', () => {
    // The access token is an httpOnly cookie, so a `src` pointed at the API would be an
    // unauthenticated request.
    expect(attachmentHref('c1', 'm1')).toBe('/inbox/attachments/c1/m1');
  });

  it('describes a size the way `describeBytes` does', () => {
    expect(describeSize(null)).toBeNull();
    expect(describeSize(0)).toBeNull();
    expect(describeSize(900)).toBe('900 bytes');
    expect(describeSize(1536)).toBe('2 KB');
    expect(describeSize(5 * 1024 * 1024)).toBe('5 MB');
    expect(describeSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('the shared inbox on the screen (`FR-WA-7`)', () => {
  it('says what state a conversation is in, and nothing when it is simply open', () => {
    // A badge reading "Open" beside every row is noise; the two states worth a sentence are the
    // ones that explain why a conversation is not in front of somebody.
    expect(describeConversationState(conversation())).toBeNull();
    expect(describeConversationState(conversation({ status: 'closed' }))).toBe('Closed.');
    expect(
      describeConversationState(
        conversation({ status: 'snoozed', snoozedUntil: '2026-10-21T09:00:00.000Z' }),
      ),
    ).toMatch(/^Put aside until /);
    // A snoozed row with no instant should still read as something: the CHECK makes it
    // unrepresentable in the database, and a screen that threw on it would be worse than one that
    // says less.
    expect(describeConversationState(conversation({ status: 'snoozed' }))).toBe('Put aside.');
  });

  it('offers snooze choices that are all in the future, resolved against now', () => {
    const now = new Date('2026-10-20T22:30:00.000Z');
    const choices = snoozeChoices(now);
    expect(choices.map((choice) => choice.label)).toEqual([
      'In 3 hours',
      'Tomorrow morning',
      'Next week',
    ]);
    for (const choice of choices) {
      // The API refuses a snooze into the past, so a choice that offered one would answer 400 —
      // and "tomorrow morning" computed from a tab left open overnight is exactly that shape.
      expect(new Date(choice.until).getTime(), choice.label).toBeGreaterThan(now.getTime());
    }
  });
});
