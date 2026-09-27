import { z } from 'zod';

/**
 * Organization, branch and team contracts.
 *
 * Note what is *not* here: the organization's slug, public key and status. A tenant cannot rename
 * its own URL (links and integrations depend on it), mint its own API identity, or lift its own
 * suspension — those are platform operations (Phase 10).
 */

const name = z.string().trim().min(2).max(120);
const timezone = z.string().trim().max(60);
const currency = z.string().trim().length(3).toUpperCase();
const country = z.string().trim().length(2).toUpperCase();

export const updateOrganizationSchema = z
  .object({
    name: name.optional(),
    legalName: z.string().trim().max(160).nullish(),
    industry: z.string().trim().max(60).nullish(),
    country: country.optional(),
    timezone: timezone.optional(),
    defaultCurrency: currency.optional(),
    defaultPhoneCountry: country.optional(),
    logoUrl: z.string().url().max(500).nullish(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const updateOnboardingSchema = z
  .object({
    step: z.string().trim().max(60).optional(),
    completed: z.boolean().optional(),
    /** Free-form per-step answers; the wizard owns the shape, not the API. */
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createBranchSchema = z
  .object({
    name,
    code: z.string().trim().min(1).max(20).toUpperCase().optional(),
    addressLine: z.string().trim().max(200).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(80).optional(),
    country: country.optional(),
    timezone: timezone.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const updateBranchSchema = createBranchSchema.partial().strict();

export const createTeamSchema = z
  .object({
    name,
    description: z.string().trim().max(500).optional(),
    branchId: z.string().uuid().nullish(),
  })
  .strict();

export const updateTeamSchema = createTeamSchema.partial().strict();

export const teamMemberSchema = z
  .object({ userId: z.string().uuid(), isLead: z.boolean().optional() })
  .strict();

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type UpdateOnboardingInput = z.infer<typeof updateOnboardingSchema>;
export type CreateBranchInput = z.infer<typeof createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof updateBranchSchema>;
export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type TeamMemberInput = z.infer<typeof teamMemberSchema>;
