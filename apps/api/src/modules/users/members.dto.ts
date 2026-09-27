import { z } from 'zod';

export const listMembersSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
    status: z.enum(['invited', 'active', 'suspended']).optional(),
    search: z.string().trim().max(120).optional(),
  })
  .strict();

export const inviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
    roleId: z.string().uuid('Choose a role'),
    teamId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
  })
  .strict();

export type ListMembersQuery = z.infer<typeof listMembersSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
