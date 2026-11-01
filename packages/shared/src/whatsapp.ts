import { isValidCustomFieldKey } from './custom-fields.js';

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

/** The types that arrive as a **file** rather than as text (`FR-WA-3`). */
export const MEDIA_MESSAGE_TYPES: readonly MessageType[] = [
  'image',
  'video',
  'audio',
  'document',
  'sticker',
];

/** How far an attachment has got. `refused` is ours; `failed` is Meta's or the network's. */
export const MEDIA_DOWNLOAD_STATUSES = ['pending', 'stored', 'refused', 'failed'] as const;
export type MediaDownloadStatus = (typeof MEDIA_DOWNLOAD_STATUSES)[number];

/**
 * What this product will accept for each kind of attachment (`FR-WA-3`).
 *
 * The ceilings are **ours**, not Meta's, and they are lower: the storage port takes a `Buffer`, so
 * every byte of an attachment is held in memory on its way through — the same constraint that caps
 * an export at 100 000 rows. Meta allows 100 MB for a document; sixteen is what this product can
 * carry honestly until the S3 driver streams, and a refusal that says so is better than an
 * out-of-memory kill that says nothing.
 *
 * The mime prefixes are an **allowlist**. A document is the one kind that has to accept anything,
 * because that is what a document is — so it is bounded by size alone, and `scan_status` on the
 * stored row is where virus scanning will land (Phase 12) rather than a guess at a type.
 */
export const MEDIA_LIMITS: Readonly<
  Record<string, { readonly maxBytes: number; readonly mimePrefixes: readonly string[] | null }>
> = {
  image: { maxBytes: 5 * 1024 * 1024, mimePrefixes: ['image/'] },
  video: { maxBytes: 16 * 1024 * 1024, mimePrefixes: ['video/'] },
  audio: { maxBytes: 16 * 1024 * 1024, mimePrefixes: ['audio/'] },
  document: { maxBytes: 16 * 1024 * 1024, mimePrefixes: null },
  sticker: { maxBytes: 512 * 1024, mimePrefixes: ['image/'] },
};

/**
 * Why an attachment will not be stored, or null when it will be.
 *
 * One decider, because three places ask: the download job (before it fetches), the upload route
 * (before it stores), and the screen (which says what it will accept). A size it cannot know yet is
 * `null` and passes — the job checks again once Meta has told it, which is the only moment the
 * answer is real.
 */
export function mediaProblem(input: {
  readonly type: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
}): { code: string; message: string } | null {
  const limit = MEDIA_LIMITS[input.type];
  if (limit === undefined) {
    return {
      code: 'MEDIA_TYPE_UNSUPPORTED',
      message: `${withArticle(input.type, true)} attachment is not something this product stores.`,
    };
  }
  if (
    limit.mimePrefixes !== null &&
    input.mimeType !== null &&
    !limit.mimePrefixes.some((prefix) => input.mimeType!.startsWith(prefix))
  ) {
    return {
      code: 'MEDIA_MIME_UNSUPPORTED',
      message: `${input.mimeType} is not a kind of ${input.type} this product stores.`,
    };
  }
  if (input.sizeBytes !== null && input.sizeBytes > limit.maxBytes) {
    return {
      code: 'MEDIA_TOO_LARGE',
      message: `That is ${describeBytes(input.sizeBytes)}, and the limit for ${withArticle(
        input.type,
      )} is ${describeBytes(limit.maxBytes)}.`,
    };
  }
  if (input.sizeBytes !== null && input.sizeBytes <= 0) {
    return { code: 'MEDIA_EMPTY', message: 'That file has no contents.' };
  }
  return null;
}

/**
 * `image` → `an image`.
 *
 * Small, and here because these sentences are shown to a business owner: "the limit for a image"
 * is the same class of mistake as "1 missed promises" — a screen that cannot write English reads
 * as machine output, which is the one thing a hand-written sentence exists to avoid.
 */
export function withArticle(noun: string, capitalise = false): string {
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a';
  return `${capitalise ? article[0]!.toUpperCase() + article.slice(1) : article} ${noun}`;
}

/** `5242880` → `5 MB`. For a sentence somebody reads, not for arithmetic. */
export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : Math.round(megabytes * 10) / 10} MB`;
}

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
  /**
   * The file Meta is holding for us, when this message is one (`FR-WA-3`).
   *
   * A delivery carries a media **id**, never the bytes: they are fetched from Meta's media endpoint
   * with the access token, which is why an inbound photo is two steps rather than one. The caption
   * is also the message's `body`, deliberately — it is text somebody wrote about the file.
   */
  readonly media: InboundWhatsAppMedia | null;
}

/** What a delivery says about an attached file, before anything has been fetched. */
export interface InboundWhatsAppMedia {
  readonly providerMediaId: string;
  readonly mimeType: string | null;
  /** Meta's own hash, kept so "is this the same file again" is answerable without the bytes. */
  readonly sha256: string | null;
  readonly fileName: string | null;
  /** True for a voice note, which Meta distinguishes from an audio file somebody attached. */
  readonly voice: boolean;
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
    media: readMedia(message, messageType),
  };
}

/**
 * The media block Meta puts under the message's own type.
 *
 * Keyed by the type rather than searched for, because `image`, `video`, `audio`, `document` and
 * `sticker` each put it under their own name and a sticker's shape is an image's. A type with no
 * media returns null, which is what stops a text message from being queued for a download.
 */
function readMedia(
  message: Record<string, unknown>,
  type: MessageType,
): InboundWhatsAppMedia | null {
  if (!MEDIA_MESSAGE_TYPES.includes(type)) return null;
  const block = message[type];
  if (block === null || typeof block !== 'object') return null;
  const media = block as Record<string, unknown>;
  const id = media['id'];
  // No id is no file: Meta sends one for everything it is holding, and a row claiming an
  // attachment nothing can fetch is worse than a row that says the message had none.
  if (typeof id !== 'string' || id === '') return null;
  return {
    providerMediaId: id,
    mimeType:
      typeof media['mime_type'] === 'string'
        ? (media['mime_type'] as string).split(';')[0]!.trim()
        : null,
    sha256: typeof media['sha256'] === 'string' ? (media['sha256'] as string) : null,
    fileName: typeof media['filename'] === 'string' ? (media['filename'] as string) : null,
    voice: media['voice'] === true,
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

// ── Sending (Phase 5 step 2) ────────────────────────────────────────────────

/**
 * What a template is for, in Meta's own words (`FR-WA-5`).
 *
 * The category decides more than the wording: a **marketing** template needs the recipient's
 * consent and is the only kind an opt-out suppresses, while `utility` and `authentication` are
 * things the customer asked for. Meta also prices them differently, which is why the category is
 * stored rather than inferred from the text.
 */
/*
 * Named `WHATSAPP_TEMPLATE_*` rather than `TEMPLATE_*` because `@leados/shared` is one barrel:
 * `industry-templates.ts` already exports a `TemplateStatus`, and the second one turns the whole
 * package into a type error nobody's own file explains.
 */
export const WHATSAPP_TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const;
export type WhatsAppTemplateCategory = (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number];

/**
 * A template's standing with Meta.
 *
 * `draft` is ours — a template nobody has submitted yet. The other five are Meta's, and
 * `rejected` always arrives with a reason, which is the one thing a person needs to see.
 */
export const WHATSAPP_TEMPLATE_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
export type WhatsAppTemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUSES)[number];

/** Only an approved template may be sent. `paused` is Meta throttling it, not us. */
export function templateIsSendable(status: WhatsAppTemplateStatus): boolean {
  return status === 'approved';
}

/**
 * Why a template cannot be sent, in a sentence for the person holding it.
 *
 * Returned rather than thrown so the screen can grey a button and say why in the same breath; the
 * write path refuses with the same sentence, so the two cannot disagree.
 */
export function templateBlockedReason(status: WhatsAppTemplateStatus): string | null {
  switch (status) {
    case 'approved':
      return null;
    case 'draft':
      return 'This template has not been submitted to WhatsApp yet.';
    case 'pending':
      return 'WhatsApp is still reviewing this template.';
    case 'rejected':
      return 'WhatsApp rejected this template. Edit it and submit it again.';
    case 'paused':
      return 'WhatsApp has paused this template because of how people reacted to it.';
    case 'disabled':
      return 'WhatsApp has disabled this template.';
    default:
      return 'This template cannot be sent.';
  }
}

/** One component of a template, as Meta structures it. */
export interface TemplateComponents {
  /** Text headers only for now: a media header needs an uploaded handle, which is a later step. */
  readonly header?: string;
  readonly body: string;
  readonly footer?: string;
  /** Quick-reply buttons, by their label. A URL button is a later step for the same reason. */
  readonly buttons?: readonly string[];
}

/**
 * The `{{1}}`, `{{2}}` … a template's text asks for, in order and without repeats.
 *
 * Meta numbers variables from 1 and requires them to be contiguous: `{{1}}` and `{{3}}` with no
 * `{{2}}` is rejected at submission, which is a slow way to find out. The header and the body are
 * numbered **separately** by Meta; this returns the body's, because a text header with a variable
 * is rare enough that the first version refuses one rather than guessing at its numbering.
 */
export function templateVariables(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index > 0) found.add(index);
  }
  return [...found].sort((left, right) => left - right);
}

/** What is wrong with a template, as field errors a form can print against its own boxes. */
export function templateProblems(input: {
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly components: TemplateComponents;
  readonly variableMap?: Readonly<Record<string, string>>;
}): { field: string; code: string; message: string }[] {
  const problems: { field: string; code: string; message: string }[] = [];
  // Meta's own rule: lower case, digits and underscores, up to 512 characters.
  if (!/^[a-z0-9_]{3,512}$/.test(input.name)) {
    problems.push({
      field: 'name',
      code: 'INVALID_TEMPLATE_NAME',
      message:
        'WhatsApp allows lower-case letters, digits and underscores only — like order_update.',
    });
  }
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(input.language)) {
    problems.push({
      field: 'language',
      code: 'INVALID_LANGUAGE',
      message: 'A WhatsApp language code, like en or en_US.',
    });
  }
  if (!(WHATSAPP_TEMPLATE_CATEGORIES as readonly string[]).includes(input.category)) {
    problems.push({
      field: 'category',
      code: 'INVALID_CATEGORY',
      message: `One of: ${WHATSAPP_TEMPLATE_CATEGORIES.join(', ')}.`,
    });
  }
  const body = input.components.body?.trim() ?? '';
  if (body === '') {
    problems.push({
      field: 'components.body',
      code: 'BODY_REQUIRED',
      message: 'A template needs a body — it is the message people read.',
    });
  }
  if (body.length > 1024) {
    problems.push({
      field: 'components.body',
      code: 'BODY_TOO_LONG',
      message: 'WhatsApp allows 1024 characters in a template body.',
    });
  }
  if (
    input.components.header !== undefined &&
    templateVariables(input.components.header).length > 0
  ) {
    problems.push({
      field: 'components.header',
      code: 'HEADER_VARIABLE_UNSUPPORTED',
      message: 'A variable in the header is not supported yet. Put it in the body.',
    });
  }
  const variables = templateVariables(body);
  variables.forEach((index, position) => {
    if (index !== position + 1) {
      problems.push({
        field: 'components.body',
        code: 'VARIABLE_GAP',
        message: `Variables must run from {{1}} with no gaps. This body jumps to {{${index}}}.`,
      });
    }
  });
  for (const index of variables) {
    const mapped = input.variableMap?.[String(index)];
    if (mapped === undefined || mapped.trim() === '') {
      problems.push({
        field: `variableMap.${index}`,
        code: 'VARIABLE_UNMAPPED',
        message: `Say what {{${index}}} should be filled in with, or the message will read "undefined".`,
      });
      continue;
    }
    // A map naming something nothing can fill is the same bug one step later: the send would be
    // refused for a missing value, on a template that looked complete when it was saved.
    if (!isTemplateVariableSource(mapped.trim())) {
      problems.push({
        field: `variableMap.${index}`,
        code: 'VARIABLE_SOURCE_UNKNOWN',
        message: `Nothing in this workspace is called "${mapped.trim()}". Choose a field, or write literal:some text.`,
      });
    }
  }
  return problems;
}

/** What a resolved template looks like before it is sent, and what is missing if anything is. */
export interface RenderedTemplate {
  readonly text: string;
  /** The positional values, in Meta's order, ready for the API's `parameters` array. */
  readonly values: readonly string[];
  /** The variables nothing could fill. A send with any of these is refused, not sent blank. */
  readonly missing: readonly string[];
}

/**
 * A template with its variables filled in.
 *
 * `values` is keyed by the variable's number as a string, which is how the variable map is stored.
 * A blank, whitespace or absent value counts as **missing**: "Hi  , your order…" is worse than a
 * refusal, and `FR-WA-5` asks for the failure to come before the send rather than after it.
 */
export function renderTemplate(
  components: TemplateComponents,
  values: Readonly<Record<string, string | null | undefined>>,
): RenderedTemplate {
  const indexes = templateVariables(components.body);
  const missing: string[] = [];
  const resolved: string[] = [];
  for (const index of indexes) {
    const value = values[String(index)];
    if (value === null || value === undefined || String(value).trim() === '') {
      missing.push(String(index));
      resolved.push('');
      continue;
    }
    resolved.push(String(value).trim());
  }
  const filled = components.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, raw: string) => {
    const value = values[String(Number(raw))];
    return value === null || value === undefined || String(value).trim() === ''
      ? `{{${Number(raw)}}}`
      : String(value).trim();
  });
  const text = [components.header, filled, components.footer]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .join('\n\n');
  return { text, values: resolved, missing };
}

/**
 * What may be sent to this conversation right now (`FR-WA-1`).
 *
 * One decider, because three places ask: the write path, the composer, and the test that proves
 * the two agree. Outside the window **only** an approved template may be sent — Meta refuses
 * anything else, and a product that queued it anyway would show an agent a sent message the
 * customer never received.
 */
export function sendingAllowed(input: {
  readonly windowExpiresAt: Date | null;
  /**
   * `media` is free-form, exactly as `text` is: Meta's rule is about a template versus anything
   * else, not about words versus files — a photo sent outside the window is refused with the same
   * error code as a sentence.
   */
  readonly kind: 'text' | 'media' | 'template';
  readonly now?: Date;
}): { allowed: true } | { allowed: false; code: string; message: string } {
  if (input.kind === 'template') return { allowed: true };
  if (windowIsOpen(input.windowExpiresAt, input.now)) return { allowed: true };
  return {
    allowed: false,
    code: 'OUTSIDE_SERVICE_WINDOW',
    message:
      input.windowExpiresAt === null
        ? 'They have never messaged this number, so only an approved template can start the conversation.'
        : 'The 24-hour reply window has closed. Only an approved template can reach them now.',
  };
}

// ── Status receipts ─────────────────────────────────────────────────────────

/**
 * How far along a message is, as an order rather than a set.
 *
 * Meta's receipts **arrive out of order** — `read` before `delivered` is routine on a busy number —
 * so a status is only written when it is further along than the one already stored. Without that,
 * a late `delivered` would overwrite `read` and the agent would watch a message go backwards.
 * `failed` is not in this order at all: it replaces whatever was there, because it is the end.
 */
export const MESSAGE_STATUS_ORDER: readonly MessageStatus[] = [
  'queued',
  'accepted',
  'sent',
  'delivered',
  'read',
];

/** Whether `next` is further along than `current`. `failed` always wins; a repeat never does. */
export function statusAdvances(current: MessageStatus, next: MessageStatus): boolean {
  if (next === 'failed') return current !== 'failed';
  if (current === 'failed') return false;
  const from = MESSAGE_STATUS_ORDER.indexOf(current);
  const to = MESSAGE_STATUS_ORDER.indexOf(next);
  if (from === -1 || to === -1) return false;
  return to > from;
}

/**
 * The statuses `next` is allowed to overwrite.
 *
 * The same rule as `statusAdvances`, in the shape an `UPDATE … WHERE status IN (…)` needs — because
 * the receipts are processed by a queue at concurrency 10, and a read-then-write on one row loses
 * the race: two receipts for one message both read `sent`, and whichever wrote second won. A
 * conditional update is atomic, needs no row lock, and answers "did it advance" in its own row
 * count. The product paid for this once already, in the scoring queue.
 */
export function statusesBeatenBy(next: MessageStatus): MessageStatus[] {
  return [...MESSAGE_STATUS_ORDER, 'failed' as MessageStatus].filter((current) =>
    statusAdvances(current, next),
  );
}

/** One status receipt out of a webhook delivery. */
export interface InboundWhatsAppStatus {
  /** The `wamid` of the message **we sent**, which is how the row is found. */
  readonly providerMessageId: string;
  readonly phoneNumberId: string;
  readonly status: MessageStatus;
  readonly occurredAt: Date;
  readonly recipientWaId: string | null;
  readonly errorCode: string | null;
  /** Meta's own sentence, kept rather than paraphrased: it is what the agent has to act on. */
  readonly errorMessage: string | null;
  readonly conversationCategory: string | null;
  readonly billable: boolean;
  readonly raw: Record<string, unknown>;
}

/**
 * The status receipts in one delivery (`FR-WA-4`).
 *
 * Meta sends these in the same `messages` change as inbound messages, under `statuses`. A status
 * for a message this workspace never sent is still returned — the pipeline decides what to do with
 * it, and dropping it here would make "nothing happened" indistinguishable from "we have no such
 * message".
 */
export function parseWhatsAppStatuses(body: Record<string, unknown>): InboundWhatsAppStatus[] {
  const entries = body['entry'];
  if (!Array.isArray(entries)) return [];
  const statuses: InboundWhatsAppStatus[] = [];

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
      const rows = Array.isArray(payload['statuses']) ? payload['statuses'] : [];
      for (const row of rows) {
        const parsed = readStatus(row, phoneNumberId);
        if (parsed !== null) statuses.push(parsed);
      }
    }
  }
  return statuses;
}

function readStatus(raw: unknown, phoneNumberId: string): InboundWhatsAppStatus | null {
  if (raw === null || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = row['id'];
  const status = row['status'];
  if (typeof id !== 'string' || id === '') return null;
  if (typeof status !== 'string') return null;
  // Meta's vocabulary is ours for these four; anything else (`deleted`, a new one) is not a
  // transition we model, and inventing one would move a message to a status nothing else reads.
  const known: Record<string, MessageStatus> = {
    sent: 'sent',
    delivered: 'delivered',
    read: 'read',
    failed: 'failed',
  };
  const mapped = known[status];
  if (mapped === undefined) return null;

  const timestamp = Number(row['timestamp']);
  const occurredAt =
    Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();

  // Meta sends `errors: [{ code, title, message, error_data: { details } }]`. The details are the
  // sentence worth showing — "Message failed to send because more than 24 hours have passed since
  // the customer last replied to this number" — and the title is the generic one.
  const errors = Array.isArray(row['errors']) ? row['errors'] : [];
  const first = (errors[0] ?? null) as Record<string, unknown> | null;
  const details = (first?.['error_data'] as { details?: unknown } | undefined)?.details;
  const errorMessage =
    typeof details === 'string' && details.trim() !== ''
      ? details.trim()
      : typeof first?.['title'] === 'string'
        ? (first['title'] as string)
        : typeof first?.['message'] === 'string'
          ? (first['message'] as string)
          : null;
  const code = first?.['code'];

  const conversation = row['conversation'] as { origin?: { type?: unknown } } | undefined;
  const pricing = row['pricing'] as { billable?: unknown; category?: unknown } | undefined;
  const category =
    typeof pricing?.category === 'string'
      ? pricing.category
      : typeof conversation?.origin?.type === 'string'
        ? conversation.origin.type
        : null;

  return {
    providerMessageId: id,
    phoneNumberId,
    status: mapped,
    occurredAt,
    recipientWaId: typeof row['recipient_id'] === 'string' ? row['recipient_id'] : null,
    errorCode: code === undefined || code === null ? null : String(code),
    errorMessage,
    conversationCategory: category,
    billable: pricing?.billable === true,
    raw: row,
  };
}

/**
 * What a template variable may be filled from (`FR-WA-5`).
 *
 * A **declared** list, because three things read it: the picker on the template screen, the
 * resolver on the send path, and the validator that refuses a map naming something nothing can
 * fill. `custom.<key>` is open-ended by design — a workspace's own fields are rows, not an enum —
 * and `literal:<text>` is how somebody puts a fixed word in a template without inventing a field
 * for it.
 */
export const TEMPLATE_VARIABLE_SOURCES = [
  { key: 'lead.fullName', label: 'Their full name' },
  { key: 'lead.firstName', label: 'Their first name' },
  { key: 'lead.phone', label: 'Their phone number' },
  { key: 'lead.email', label: 'Their email address' },
  { key: 'lead.city', label: 'Their city' },
  { key: 'lead.status', label: 'Their status in this workspace' },
  { key: 'lead.owner', label: 'Whoever owns the lead' },
  { key: 'organization.name', label: 'This workspace’s name' },
] as const;

/** Whether a variable map's value names something the resolver can actually fill. */
export function isTemplateVariableSource(value: string): boolean {
  if (value.startsWith('literal:')) return value.slice('literal:'.length).trim() !== '';
  if (value.startsWith('custom.')) return isValidCustomFieldKey(value.slice('custom.'.length));
  return TEMPLATE_VARIABLE_SOURCES.some((source) => source.key === value);
}
