import { z } from 'zod';
import { CONVERSATION_STATUSES } from '@leados/shared';

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
export type ListConversationsQuery = z.infer<typeof listConversationsSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesSchema>;
export type ConnectWabaInput = z.infer<typeof connectWabaSchema>;
