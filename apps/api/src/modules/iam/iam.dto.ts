import { z } from 'zod';

const scope = z.enum(['own', 'team', 'branch', 'organization']);

export const createRoleSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9_]{1,40}$/, 'Use lowercase letters, numbers and underscores'),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).optional(),
    grants: z
      .array(z.object({ permission: z.string().trim().min(3).max(60), scope }).strict())
      .max(200)
      .optional(),
  })
  .strict();

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(300).nullish(),
  })
  .strict();

export const setRoleGrantsSchema = z
  .object({
    grants: z
      .array(z.object({ permission: z.string().trim().min(3).max(60), scope }).strict())
      .max(200),
  })
  .strict();

export const setUserRolesSchema = z
  .object({ roleIds: z.array(z.string().uuid()).min(1).max(10) })
  .strict();

export const updateMemberSchema = z
  .object({
    defaultBranchId: z.string().uuid().nullish(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type SetRoleGrantsInput = z.infer<typeof setRoleGrantsSchema>;
export type SetUserRolesInput = z.infer<typeof setUserRolesSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
