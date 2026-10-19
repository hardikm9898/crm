/**
 * WhatsApp's own vocabulary (`FR-WA-1`…`FR-WA-6`), pure and tested on its own.
 *
 * Here rather than in the API for the reason the integration registry gives: the inbox renders the
 * same message types and the same window countdown that the write path enforces, and a second copy
 * of either would be the one that is wrong. The web app hand-writes its own copy and a spec
 * reconciles them, because `@leados/shared` reaches `node:async_hooks` and a client component may
 * not import it.
 */

/**
 * What a message is.
 *
 * Meta's own words, because they arrive in the payload and anything we renamed would have to be
 * translated back in two directions. `system` is ours: a line in the conversation that nobody sent
 * — "this conversation was closed", "the window expired".
 */
export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'location',
  'contacts',
  'sticker',
  'template',
  'interactive',
  'reaction',
  'system',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** The types this step can actually store the content of. The rest arrive with media and sending. */
export const SUPPORTED_INBOUND_TYPES: readonly MessageType[] = [
  'text',
  'location',
  'contacts',
  'reaction',
  'interactive',
];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * A message's standing (`FR-WA-4`).
 *
 * Meta's transitions in order: we queue it, Meta accepts it, it is sent, delivered, read. `failed`
 * can replace any of them. An **inbound** message is `delivered` the moment we have it — it is in
 * our hands, and there is nothing further to wait for.
 */
export const MESSAGE_STATUSES = [
  'queued',
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const CONVERSATION_STATUSES = ['open', 'pending', 'snoozed', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_CHANNELS = ['whatsapp', 'email', 'sms', 'webchat'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

/**
 * How long a business may reply freely after the customer's last message (`FR-WA-1`).
 *
 * Twenty-four hours, Meta's rule, as a constant because three things read it: the write path that
 * refuses a free-form send, the countdown the inbox shows, and the sweep that closes the window.
 * A number inlined in any of them is a number that disagrees with the other two.
 */
export const SERVICE_WINDOW_HOURS = 24;

/** When the free-reply window closes, given the customer's last message. */
export function windowExpiryFrom(lastInboundAt: Date): Date {
  return new Date(lastInboundAt.getTime() + SERVICE_WINDOW_HOURS * 3_600_000);
}

/** Whether a free-form reply is allowed right now. A conversation with no inbound message has none. */
export function windowIsOpen(windowExpiresAt: Date | null, now: Date = new Date()): boolean {
  return windowExpiresAt !== null && windowExpiresAt.getTime() > now.getTime();
}

/**
 * How long is left, in the words the inbox shows.
 *
 * Rounded **down**, because a window that reads "1 hour left" and refuses the send a minute later
 * is worse than one that reads "59 minutes". The exact instant is on the row for anybody who needs
 * it.
 */
export function describeWindow(windowExpiresAt: Date | null, now: Date = new Date()): string {
  if (windowExpiresAt === null) {
    return 'They have never messaged you, so only a template can start a conversation.';
  }
  const remaining = windowExpiresAt.getTime() - now.getTime();
  if (remaining <= 0) {
    return 'The 24-hour reply window has closed. Only an approved template can reach them now.';
  }
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left to reply freely.`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} left to reply freely.`;
}

// ── Inbound payloads ────────────────────────────────────────────────────────

/** One message out of one webhook delivery, as the pipeline needs it. */
export interface InboundWhatsAppMessage {
  /** Meta's `wamid.…`, which is the idempotency key and is unique across every workspace. */
  readonly providerMessageId: string;
  /** The business number it arrived at, as Meta's own id. */
  readonly phoneNumberId: string;
  /** Who sent it, in E.164 without the `+` as Meta sends it — normalised by the caller. */
  readonly fromWaId: string;
  /** What WhatsApp calls them, when the customer has set a name. */
  readonly profileName: string | null;
  readonly type: MessageType;
  /** The text, the caption, or the readable shape of whatever else arrived. Null for media. */
  readonly body: string | null;
  /** Everything Meta sent for this message, kept whole. */
  readonly raw: Record<string, unknown>;
  readonly occurredAt: Date;
  /** The message this one is a reply or a reaction to, when Meta says. */
  readonly replyToProviderId: string | null;
}

/**
 * The messages in one `entry[].changes[]` delivery.
 *
 * Meta batches: one request can carry several messages, from several numbers, and `statuses` for
 * messages we sent earlier. Each message is deduplicated on its **own** `wamid`, because a retry of
 * a batch of three must not turn on whether all three were new.
 *
 * A type this step cannot store the content of is still **returned**, with a null body: the row is
 * what makes "they sent us a photo" visible in the inbox at all, and dropping it would make the
 * conversation read as though nothing arrived. Media download is a later step; the provider's own
 * payload is on the row for it.
 */
export function parseWhatsAppMessages(body: Record<string, unknown>): InboundWhatsAppMessage[] {
  const entries = body['entry'];
  if (!Array.isArray(entries)) return [];
  const messages: InboundWhatsAppMessage[] = [];

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const field = (change as { field?: unknown })?.field;
      const value = (change as { value?: unknown })?.value;
      if (field !== 'messages' || value === null || typeof value !== 'object') continue;
      const payload = value as Record<string, unknown>;
      const phoneNumberId = readPhoneNumberId(payload);
      if (phoneNumberId === null) continue;

      const contacts = Array.isArray(payload['contacts']) ? payload['contacts'] : [];
      const names = new Map<string, string>();
      for (const contact of contacts) {
        const waId = (contact as { wa_id?: unknown })?.wa_id;
        const name = (contact as { profile?: { name?: unknown } })?.profile?.name;
        if (typeof waId === 'string' && typeof name === 'string' && name.trim() !== '') {
          names.set(waId, name.trim());
        }
      }

      const inbound = Array.isArray(payload['messages']) ? payload['messages'] : [];
      for (const message of inbound) {
        const parsed = readMessage(message, phoneNumberId, names);
        if (parsed !== null) messages.push(parsed);
      }
    }
  }
  return messages;
}

function readPhoneNumberId(payload: Record<string, unknown>): string | null {
  const metadata = payload['metadata'];
  if (metadata === null || typeof metadata !== 'object') return null;
  const id = (metadata as { phone_number_id?: unknown }).phone_number_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function readMessage(
  raw: unknown,
  phoneNumberId: string,
  names: Map<string, string>,
): InboundWhatsAppMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const message = raw as Record<string, unknown>;
  const id = message['id'];
  const from = message['from'];
  const type = message['type'];
  if (typeof id !== 'string' || id === '') return null;
  if (typeof from !== 'string' || from === '') return null;
  // A type we have never heard of is stored as `system` with the payload intact rather than
  // dropped: Meta adds types, and a conversation that silently skips one reads as a message nobody
  // sent — which is worse than a row saying "something arrived we do not render yet".
  const known = (MESSAGE_TYPES as readonly string[]).includes(String(type));
  const messageType = (known ? String(type) : 'system') as MessageType;

  // Meta sends seconds, as a string.
  const timestamp = Number(message['timestamp']);
  const occurredAt =
    Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();

  return {
    providerMessageId: id,
    phoneNumberId,
    fromWaId: from,
    profileName: names.get(from) ?? null,
    type: messageType,
    body: readBody(message, messageType),
    raw: message,
    occurredAt,
    replyToProviderId: readContextId(message),
  };
}

/**
 * The readable content of a message, for the inbox list and for search.
 *
 * Only what is genuinely text: a photo's caption is text **about** a photo and is kept, but a photo
 * with no caption has no body and gets null rather than a placeholder sentence — a body that said
 * "[image]" would be indistinguishable from somebody typing that, and it would be indexed as if
 * they had.
 */
function readBody(message: Record<string, unknown>, type: MessageType): string | null {
  const pick = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

  switch (type) {
    case 'text':
      return pick((message['text'] as { body?: unknown } | undefined)?.body);
    case 'reaction':
      return pick((message['reaction'] as { emoji?: unknown } | undefined)?.emoji);
    case 'interactive': {
      const interactive = message['interactive'] as Record<string, unknown> | undefined;
      return (
        pick((interactive?.['button_reply'] as { title?: unknown } | undefined)?.title) ??
        pick((interactive?.['list_reply'] as { title?: unknown } | undefined)?.title)
      );
    }
    case 'location': {
      const location = message['location'] as Record<string, unknown> | undefined;
      return pick(location?.['name']) ?? pick(location?.['address']);
    }
    case 'contacts':
      return null;
    default:
      // Every media type carries an optional caption under its own key.
      for (const key of ['image', 'video', 'audio', 'document', 'sticker'] as const) {
        const caption = pick((message[key] as { caption?: unknown } | undefined)?.caption);
        if (caption !== null) return caption;
      }
      return null;
  }
}

function readContextId(message: Record<string, unknown>): string | null {
  // Two places, and the early return on a missing `context` is what the first draft got wrong: a
  // reaction has no `context` at all, so returning null there skipped the branch below and every
  // reaction lost the message it was about. Fall through, never return early.
  const context = message['context'];
  if (context !== null && typeof context === 'object') {
    const id = (context as { id?: unknown }).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  // A reaction names its subject under its own key rather than in `context`.
  const reaction = message['reaction'];
  const reactedTo = (reaction as { message_id?: unknown } | undefined)?.message_id;
  return typeof reactedTo === 'string' && reactedTo !== '' ? reactedTo : null;
}

/**
 * Meta's `wa_id` as E.164.
 *
 * Meta sends `919845012345` — digits, no plus, and **not** always the number the customer's phone
 * displays: for some countries Meta strips a trunk prefix that `normalizePhone` would put back. So
 * this only adds the `+`, and the workspace's own normaliser is never asked to guess at a number a
 * provider has already canonicalised.
 */
export function waIdToE164(waId: string): string | null {
  const digits = waId.replace(/\D+/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** The line a conversation list shows when the last message has no text of its own. */
export function describeMessagePreview(type: MessageType, body: string | null): string {
  if (body !== null && body.trim() !== '') return body;
  switch (type) {
    case 'image':
      return 'Sent a photo';
    case 'video':
      return 'Sent a video';
    case 'audio':
      return 'Sent a voice note';
    case 'document':
      return 'Sent a document';
    case 'sticker':
      return 'Sent a sticker';
    case 'location':
      return 'Shared a location';
    case 'contacts':
      return 'Shared a contact';
    case 'template':
      return 'A template message';
    default:
      return 'A message we do not display yet';
  }
}
