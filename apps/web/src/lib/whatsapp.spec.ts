import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_STATUSES as API_CONVERSATION_STATUSES,
  MESSAGE_DIRECTIONS as API_MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES as API_MESSAGE_STATUSES,
  MESSAGE_TYPES as API_MESSAGE_TYPES,
} from '@leados/shared';
import {
  CONVERSATION_STATUSES,
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
