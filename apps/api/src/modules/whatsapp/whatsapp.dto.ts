import { z } from 'zod';
import {
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
    limit: z.coerce.number().int().min(1).max(100).default(25),
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
    z.object({ kind: z.literal('text'), body: z.string().trim().min(1).max(4096) }).strict(),
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
