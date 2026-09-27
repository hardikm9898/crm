import { z } from 'zod';

/**
 * Request contracts. Zod is the single source of validation truth: the same schemas can be
 * shared with the web client, so a form and its endpoint cannot disagree
 * (docs/frontend-architecture.md §3).
 *
 * Every schema is `.strict()`: unknown keys are rejected rather than silently ignored, so a
 * typo in a client payload surfaces immediately instead of being dropped.
 */

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const password = z.string().min(1, 'Password is required').max(200);
const personName = z.string().trim().min(1, 'Name is required').max(120);

export const registerSchema = z
  .object({
    email,
    password,
    name: personName,
    organizationName: z.string().trim().min(2, 'Business name is required').max(120),
    industry: z.string().trim().max(60).optional(),
    timezone: z.string().trim().max(60).optional(),
    country: z.string().trim().length(2, 'Use a two-letter country code').toUpperCase().optional(),
  })
  .strict();

export const loginSchema = z.object({ email, password }).strict();

export const mfaLoginSchema = z
  .object({
    challengeToken: z.string().min(10),
    code: z.string().trim().min(6).max(20),
  })
  .strict();

/**
 * The refresh token may arrive in the body (mobile, server-to-server) or in the httpOnly
 * cookie (browser). The body is optional here and the controller resolves the source.
 */
export const refreshSchema = z.object({ refreshToken: z.string().min(10).optional() }).strict();

export const requestPasswordResetSchema = z.object({ email }).strict();

export const resetPasswordSchema = z.object({ token: z.string().min(10), password }).strict();

export const verifyEmailSchema = z.object({ token: z.string().min(10) }).strict();

export const resendVerificationSchema = z.object({ email }).strict();

export const mfaConfirmSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit code'),
  })
  .strict();

export const mfaDisableSchema = z.object({ password }).strict();

export const switchOrganizationSchema = z.object({ organizationId: z.string().uuid() }).strict();

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(10),
    name: personName.optional(),
    password: password.optional(),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type MfaLoginInput = z.infer<typeof mfaLoginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
