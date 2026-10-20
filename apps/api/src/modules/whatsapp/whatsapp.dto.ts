import { z } from 'zod';
import {
  CANNED_REPLY_VISIBILITIES,
  CONVERSATION_STATUSES,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATUSES,
} from '@leados/shared';

/**
 * Request shapes for the inbox and the WhatsApp connection (`FR-WA-2`, `FR-WA-7`).
 *
 * `assigned` is a three-way filter and `undefined` stays `undefined`: absent means "everybody's",
 * which is not the same as `unassigned`. The trap a `z.boolean()` query parameter paid for, in the
 * shape it takes when the third value is a word rather than a boolean.
 */
export const listConversationsSchema = z
  .object({
    status: z.enum(CONVERSATION_STATUSES).optional(),
    assigned: z.enum(['me', 'unassigned']).optional(),
    numberId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    unread: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    /** Matches a message body or the contact's number. */
    q: z.string().trim().max(200).optional(),
    /** A tag the conversation carries. One, because a filter chip is one tag (`FR-WA-7`). */
    tag: z.string().trim().min(1).max(40).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /**
     * The last row of the previous page, as `<lastMessageAt ISO>_<id>`.
     *
     * **Both halves**, because `last_message_at` ties: two conversations whose newest message
     * arrived in the same second would otherwise make one page's last row the next page's first,
     * and a row in between would be skipped. The same reason a cursor over `messages` carries the
     * partition key — an id alone selects the wrong page.
     *
     * Opaque to the client by convention: it is the `nextCursor` the previous response gave.
     */
    cursor: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[0-9a-f-]{36}$/,
        'That is not a cursor this endpoint issued.',
      )
      .optional(),
  })
  .strict();

export const listMessagesSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** A message id, read with its instant: both halves of a partitioned table's key. */
    before: z.string().uuid().optional(),
  })
  .strict();

/**
 * Connecting a WABA (`FR-WA-2`).
 *
 * The **numbers are not here**: they are discovered from Meta with the token, because
 * `phone_number_id` is what resolves an inbound delivery to a workspace and a number somebody
 * mistyped would silently receive nothing.
 */
export const connectWabaSchema = z
  .object({
    /** The integration connection holding the credential. */
    connectionId: z.string().uuid(),
  })
  .strict();

/**
 * Who answers a number when nobody has claimed a conversation (`FR-WA-2`).
 *
 * `nullable`, not optional: "nobody by default" is a real answer, and a schema that only accepted
 * a uuid would make an unclaimed number unrepresentable — the state most workspaces start in.
 */
export const setDefaultAgentSchema = z.object({ userId: z.string().uuid().nullable() }).strict();

export type SetDefaultAgentInput = z.infer<typeof setDefaultAgentSchema>;
/**
 * Sending (`FR-WA-1`, `FR-WA-5`).
 *
 * A discriminated union rather than a bag of optional fields, because the two kinds are refused for
 * different reasons and a `{ body?, templateId? }` with both set has no honest meaning.
 */
export const sendMessageSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('text'),
        body: z.string().trim().min(1).max(4096),
        /**
         * The canned reply this came from, when it came from one (`FR-WA-7`).
         *
         * The **body** is still what is sent, not the reply's own wording: an agent edits a canned
         * reply before sending it more often than not, and a send that silently used the stored
         * text would put words in their mouth. This is only what increments `usage_count`, which
         * is why that count means "times sent" rather than "times clicked".
         */
        cannedReplyId: z.string().uuid().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('template'),
        templateId: z.string().uuid(),
        /** What the agent typed for a variable the record cannot supply, keyed by its number. */
        variables: z.record(z.string().regex(/^\d+$/), z.string().trim().max(1024)).optional(),
      })
      .strict(),
  ]);

const templateComponentsSchema = z
  .object({
    header: z.string().trim().max(60).optional(),
    body: z.string().trim().min(1).max(1024),
    footer: z.string().trim().max(60).optional(),
    buttons: z.array(z.string().trim().min(1).max(25)).max(3).optional(),
  })
  .strict();

export const createTemplateSchema = z
  .object({
    accountId: z.string().uuid(),
    name: z.string().trim().min(3).max(512),
    language: z.string().trim().min(2).max(10),
    category: z.enum(WHATSAPP_TEMPLATE_CATEGORIES),
    components: templateComponentsSchema,
    /** `{ "1": "lead.fullName" }` — what fills each variable. Validated against the registry. */
    variableMap: z.record(z.string().regex(/^\d+$/), z.string().trim().min(1).max(120)).optional(),
  })
  .strict();

export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(3).max(512).optional(),
    language: z.string().trim().min(2).max(10).optional(),
    category: z.enum(WHATSAPP_TEMPLATE_CATEGORIES).optional(),
    components: templateComponentsSchema.optional(),
    variableMap: z.record(z.string().regex(/^\d+$/), z.string().trim().min(1).max(120)).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const listTemplatesSchema = z
  .object({
    status: z.enum(WHATSAPP_TEMPLATE_STATUSES).optional(),
    accountId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const syncTemplatesSchema = z.object({ accountId: z.string().uuid() }).strict();

export const previewTemplateSchema = z
  .object({ leadId: z.string().uuid().optional() })
  .strict();

/**
 * A conversation's tags, as a whole set (`FR-WA-7`).
 *
 * The set and not add-one/remove-one: a tag editor is a row of chips, and two endpoints for one
 * field is how a screen and an API end up disagreeing about what is on a row. `normaliseTags` then
 * lower-cases and hyphenates, so `Site Visit` and `site-visit` cannot be two chips for one idea.
 */
export const setTagsSchema = z
  .object({ tags: z.array(z.string().trim().max(60)).max(20) })
  .strict();

export const createCannedReplySchema = z
  .object({
    /** `/price-list`. The slash is added for you — making somebody type punctuation exactly is how
     * a feature goes unused. */
    shortcut: z.string().trim().min(1).max(40),
    body: z.string().trim().min(1).max(1024),
    visibility: z.enum(CANNED_REPLY_VISIBILITIES).default('shared'),
  })
  .strict();

export const updateCannedReplySchema = z
  .object({
    shortcut: z.string().trim().min(1).max(40).optional(),
    body: z.string().trim().min(1).max(1024).optional(),
    visibility: z.enum(CANNED_REPLY_VISIBILITIES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

/**
 * The usage window (`FR-BIL-4`).
 *
 * Both ends, defaulting to this month — the period an invoice covers, which is the only reason
 * anybody opens this screen. `z.coerce.date()` because a query string carries strings.
 */
export const usageQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

/**
 * The shared inbox's own mutations (`FR-WA-7`).
 *
 * `assignedUserId` is **nullable and that is a real answer**, not laxity: "put this back in the
 * pool" is what an agent going on holiday needs, and a conversation nobody owns is visible to
 * everybody who can read it. `.nullable()` rather than `.optional()`, so an absent key and an
 * explicit `null` cannot be confused — the `?flag=true` lesson, in a body.
 */
export const assignConversationSchema = z
  .object({
    assignedUserId: z.string().uuid().nullable(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * A transfer insists on both halves.
 *
 * The recipient is required because a transfer to nobody is an unassignment, which has its own
 * endpoint; the note is required because "transfer is audited" is this phase's exit criterion and
 * an audit row with no reason answers nothing three weeks later.
 */
export const transferConversationSchema = z
  .object({
    toUserId: z.string().uuid(),
    note: z.string().trim().min(1).max(500),
  })
  .strict();

export const closeConversationSchema = z
  .object({ note: z.string().trim().min(1).max(500).optional() })
  .strict();

export const snoozeConversationSchema = z
  .object({
    /** An instant, not a duration: the screen offers "this afternoon" and sends what that means. */
    until: z.coerce.date(),
  })
  .strict();

/**
 * An internal note, and who it names.
 *
 * The ids are what the product acts on and the body is what somebody typed, submitted together so
 * they cannot disagree — a service that parsed `@Asha` out of the text would tell the wrong Asha
 * the moment a workspace has two.
 */
export const createNoteSchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    mentionedUserIds: z.array(z.string().uuid()).max(20).optional(),
  })
  .strict();

/**
 * What comes with an attachment's bytes (`FR-WA-3`).
 *
 * In the query string rather than the body, because the body **is** the file: a raw upload has
 * nowhere else to carry its own name. `fileName` matters more than it looks — WhatsApp shows it to
 * the person receiving a document, so "the quotation" and `blob` are the difference between a file
 * somebody opens and one they do not.
 */
export const attachmentQuerySchema = z
  .object({
    fileName: z.string().trim().min(1).max(240),
    caption: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type ListTemplatesQuery = z.infer<typeof listTemplatesSchema>;
export type PreviewTemplateQuery = z.infer<typeof previewTemplateSchema>;
export type SyncTemplatesInput = z.infer<typeof syncTemplatesSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesSchema>;
export type ConnectWabaInput = z.infer<typeof connectWabaSchema>;
export type AttachmentQuery = z.infer<typeof attachmentQuerySchema>;
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;
export type TransferConversationInput = z.infer<typeof transferConversationSchema>;
export type CloseConversationInput = z.infer<typeof closeConversationSchema>;
export type SnoozeConversationInput = z.infer<typeof snoozeConversationSchema>;
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type SetTagsInput = z.infer<typeof setTagsSchema>;
export type CreateCannedReplyInput = z.infer<typeof createCannedReplySchema>;
export type UpdateCannedReplyInput = z.infer<typeof updateCannedReplySchema>;
export type UsageQuery = z.infer<typeof usageQuerySchema>;
