import { request } from '@/lib/api';

/**
 * The WhatsApp inbox, as the screens read it (`FR-WA-1..8`).
 *
 * The vocabulary is **declared here rather than imported from `@leados/shared`**, for the reason
 * `lib/tasks.ts` and `lib/sla.ts` both record: that package's entry point reaches
 * `node:async_hooks` through the tenant context, and a client component that transitively imports
 * it fails `next build` outright — on whichever page happens to render it, not on the file that
 * imported it. `whatsapp.spec.ts` runs in Node, may import both, and reconciles the two lists.
 *
 * None of the 24-hour window's arithmetic is repeated here. The API answers `windowIsOpen` and
 * `windowSummary` beside the instant, so the one definition of `FR-WA-1` stays in the one place
 * that also enforces it — a second implementation on the screen is how "the button was enabled and
 * the send was refused" happens.
 */
export const CONVERSATION_STATUSES = ['open', 'pending', 'snoozed', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_STATUSES = [
  'queued',
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

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

/** What a filter chip says, in the words an agent uses rather than the column's. */
export const STATUS_LABELS: Readonly<Record<ConversationStatus, string>> = {
  open: 'Open',
  pending: 'Waiting on us',
  snoozed: 'Snoozed',
  closed: 'Closed',
};

/** What a message's standing says under it. `delivered` on an inbound row is not worth saying. */
export const STATUS_WORDS: Readonly<Record<MessageStatus, string>> = {
  queued: 'Queued',
  accepted: 'Accepted by WhatsApp',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Not delivered',
};

export interface ConversationSummary {
  id: string;
  channel: string;
  contact: string | null;
  number: { id: string; displayPhoneE164: string; verifiedName: string | null } | null;
  lead: { id: string; fullName: string } | null;
  assignedTo: { id: string; name: string } | null;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  windowExpiresAt: string | null;
  /** Both, because they answer different questions: one disables a button, one is read. */
  windowIsOpen: boolean;
  windowSummary: string;
  tags: string[];
  lastMessage: {
    direction: MessageDirection;
    type: MessageType;
    preview: string;
    createdAt: string;
  } | null;
  createdAt: string;
}

/** `FR-WA-8`: the lead's own context, on the same screen as the conversation. */
export interface ConversationDetail extends ConversationSummary {
  lead:
    | (ConversationSummary['lead'] & {
        phone: string | null;
        email: string | null;
        score: number;
        status: { id: string; name: string } | null;
        owner: { id: string; name: string } | null;
      })
    | null;
}

export interface ConversationMessage {
  id: string;
  direction: MessageDirection;
  type: MessageType;
  body: string | null;
  /** The body, or the sentence that stands in for media — never "[image]". */
  preview: string;
  status: MessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  providerMessageId: string | null;
  replyToProviderId: string | null;
  sender: { id: string; name: string } | null;
  createdAt: string;
}

export interface WhatsAppNumber {
  id: string;
  phoneNumberId: string;
  displayPhoneE164: string;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  isActive: boolean;
  /** The member who answers this number by default, as the API sends it: an id, not a name. */
  defaultAgentUserId: string | null;
}

export interface WhatsAppAccount {
  id: string;
  wabaId: string;
  businessName: string | null;
  status: string;
  connectionId: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  numbers: WhatsAppNumber[];
}

export const WHATSAPP_TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const;
export type WhatsAppTemplateCategory = (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number];

export const WHATSAPP_TEMPLATE_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
export type WhatsAppTemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUSES)[number];

/** What a template's standing is called on the screen. Never the column's own word. */
export const TEMPLATE_STATUS_LABELS: Readonly<Record<WhatsAppTemplateStatus, string>> = {
  draft: 'Draft',
  pending: 'With WhatsApp',
  approved: 'Approved',
  rejected: 'Rejected',
  paused: 'Paused by WhatsApp',
  disabled: 'Disabled by WhatsApp',
};

export const TEMPLATE_STATUS_TONES: Readonly<
  Record<WhatsAppTemplateStatus, 'neutral' | 'success' | 'warning' | 'danger'>
> = {
  draft: 'neutral',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  paused: 'warning',
  disabled: 'danger',
};

export const TEMPLATE_CATEGORY_LABELS: Readonly<Record<WhatsAppTemplateCategory, string>> = {
  marketing: 'Marketing — needs their consent',
  utility: 'Utility — about something they asked for',
  authentication: 'Authentication — a code or a sign-in',
};

export interface TemplateComponents {
  header?: string;
  body: string;
  footer?: string;
  buttons?: string[];
}

export interface WhatsAppTemplate {
  id: string;
  accountId: string;
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  status: WhatsAppTemplateStatus;
  rejectionReason: string | null;
  components: TemplateComponents;
  variableMap: Record<string, string>;
  providerTemplateId: string | null;
  submittedAt: string | null;
  syncedAt: string | null;
  createdAt: string;
  /** Both, for the same reason the window is: one greys a button, the other is read. */
  sendable: boolean;
  blockedReason: string | null;
  /** The body with its placeholders still in it, for a list to show at a glance. */
  preview: string;
}

/** Where a template's variables may be filled from. Declared, so the picker is not a text box. */
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

/** The `{{1}}`, `{{2}}` … a body asks for, in order and without repeats. */
export function templateVariables(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index > 0) found.add(index);
  }
  return [...found].sort((left, right) => left - right);
}

/** A page of conversations, with the whole filter's totals rather than the page's. */
export async function loadConversations(
  query: string,
  token: string | null,
): Promise<{
  items: ConversationSummary[];
  total: number;
  unread: number;
  open: number;
}> {
  const response = await request<ConversationSummary[]>(`/conversations${query}`, { token });
  const meta = response.meta as { unread?: number; open?: number } | undefined;
  return {
    items: response.data,
    // The API aggregates each of these over the whole filter, which is the point: a badge that
    // counted the loaded page would tell an agent their inbox is a fraction of its real size.
    total: response.pagination?.total ?? response.data.length,
    unread: meta?.unread ?? 0,
    open: meta?.open ?? 0,
  };
}

/**
 * One conversation, by id.
 *
 * Throwing, with no swallowing twin: a deep link into the inbox names the conversation it wants,
 * and a panel that silently rendered nothing would be the "deep-linked panel" trap again — the
 * screen must not search the loaded list for its subject.
 */
export async function loadConversation(
  id: string,
  token: string | null,
): Promise<ConversationDetail> {
  return (await request<ConversationDetail>(`/conversations/${id}`, { token })).data;
}

export async function loadMessages(
  id: string,
  token: string | null,
  limit = 50,
): Promise<{ items: ConversationMessage[]; nextCursor: string | null }> {
  const response = await request<ConversationMessage[]>(
    `/conversations/${id}/messages?limit=${limit}`,
    { token },
  );
  return { items: response.data, nextCursor: response.pagination?.nextCursor ?? null };
}

/**
 * The connected WABAs and their numbers.
 *
 * Swallowing, because this list sits beside the inbox as context: a settings screen that cannot
 * be read must not take the conversations down with it. The settings screen itself uses the
 * throwing twin, for the reason `loadProducts` paid for — on a screen whose whole job is to list
 * them, "none" is information and a caught 400 is a permanent, silent lie.
 */
export async function loadWhatsAppAccounts(
  token: string | null,
): Promise<{ items: WhatsAppAccount[]; numbers: number }> {
  try {
    return await loadWhatsAppAccountsOrThrow(token);
  } catch {
    return { items: [], numbers: 0 };
  }
}

export async function loadWhatsAppAccountsOrThrow(
  token: string | null,
): Promise<{ items: WhatsAppAccount[]; numbers: number }> {
  const response = await request<WhatsAppAccount[]>('/whatsapp/accounts', { token });
  const meta = response.meta as { numbers?: number } | undefined;
  return { items: response.data, numbers: meta?.numbers ?? 0 };
}

/**
 * The query string for the inbox, from what the screen's own controls are set to.
 *
 * `assigned` is three-way and absent means "everybody's": folding an absent value to `unassigned`
 * would quietly show an agent a fraction of their inbox, which is the `?flag=true` trap in the
 * shape it takes when the third value is a word.
 */
export function conversationQuery(params: {
  status?: string;
  assigned?: string;
  unread?: string;
  q?: string;
  numberId?: string;
  limit?: number;
}): string {
  const search = new URLSearchParams();
  if (params.status && isConversationStatus(params.status)) search.set('status', params.status);
  if (params.assigned === 'me' || params.assigned === 'unassigned') {
    search.set('assigned', params.assigned);
  }
  if (params.unread === 'true' || params.unread === 'false') search.set('unread', params.unread);
  if (params.q && params.q.trim() !== '') search.set('q', params.q.trim());
  if (params.numberId) search.set('numberId', params.numberId);
  search.set('limit', String(params.limit ?? 25));
  return `?${search.toString()}`;
}

export function isConversationStatus(value: string): value is ConversationStatus {
  return (CONVERSATION_STATUSES as readonly string[]).includes(value);
}

/**
 * "Asha Rao", or the number, or "Unknown number" — in that order.
 *
 * A row headed by a raw `wa_id` is a row an agent has to decode, and a conversation whose lead has
 * no name yet (a first message from a number nobody has met) still has to read as somebody.
 */
export function conversationTitle(conversation: ConversationSummary): string {
  const name = conversation.lead?.fullName?.trim();
  if (name) return name;
  return conversation.contact ?? 'Unknown number';
}

/** `FR-WA-4`'s standing, for an outbound row only. An inbound "Delivered" says nothing. */
export function messageStanding(message: ConversationMessage): string | null {
  if (message.direction === 'inbound') return null;
  if (message.status === 'failed') {
    return message.errorMessage ?? STATUS_WORDS.failed;
  }
  return STATUS_WORDS[message.status] ?? null;
}

/**
 * The templates this workspace has.
 *
 * Throwing, with no swallowing twin: on a screen whose whole job is to list them, "none" is
 * information somebody acts on, and a caught failure would tell a workspace with ten approved
 * templates to go and write their first.
 */
export async function loadTemplates(
  token: string | null,
  query = '',
): Promise<{ items: WhatsAppTemplate[]; approved: number }> {
  const response = await request<WhatsAppTemplate[]>(`/whatsapp/templates${query}`, { token });
  const meta = response.meta as { approved?: number } | undefined;
  return { items: response.data, approved: meta?.approved ?? 0 };
}

/**
 * The ones a composer may actually offer.
 *
 * Swallowing, because this sits beside a conversation: an agent whose template list failed to load
 * can still type a reply, and a thread that will not open because of it is worse.
 */
export async function loadSendableTemplates(token: string | null): Promise<WhatsAppTemplate[]> {
  try {
    // Twenty-five, because each one is previewed against this conversation's lead and a picker with
    // more than that needs a search box rather than a longer list — which is a later step's
    // problem, not a reason to make opening a conversation cost a hundred requests.
    return (await loadTemplates(token, '?status=approved&limit=25')).items;
  } catch {
    return [];
  }
}

export interface TemplatePreview {
  text: string;
  values: string[];
  missing: string[];
  blockedReason: string | null;
}

/** What this template will say to this person — the whole point of a preview. */
export async function previewTemplate(
  id: string,
  leadId: string | null,
  token: string | null,
): Promise<TemplatePreview | null> {
  try {
    const query = leadId === null ? '' : `?leadId=${leadId}`;
    return (await request<TemplatePreview>(`/whatsapp/templates/${id}/preview${query}`, { token }))
      .data;
  } catch {
    // A preview that cannot be rendered must not stop the screen it sits on.
    return null;
  }
}

/** Whether this message is one an agent can do something about. */
export function needsAttention(message: ConversationMessage): boolean {
  return message.direction === 'outbound' && message.status === 'failed';
}
