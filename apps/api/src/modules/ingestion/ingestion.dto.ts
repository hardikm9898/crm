import { z } from 'zod';
import { INBOUND_STATUSES, INGEST_CHANNELS } from '@leados/shared';

/**
 * Request shapes for the public lead API (`FR-CAP-5`, `FR-CAP-6`).
 *
 * The payload schema is **permissive on purpose**, which is the opposite of every other schema in
 * this codebase and the whole point of `FR-CAP-5`: "ingestion MUST accept unknown/extra fields
 * without failing". So it is `.passthrough()`, every field is optional, and what the API cannot use
 * is kept in `raw_body` and reported back as an unmapped field rather than refused.
 *
 * What is still checked here is shape rather than meaning: a phone that is a number instead of a
 * string, an email longer than the column, a `customFields` that is an array. Meaning — can this
 * phone be normalised with the workspace's country, does that custom field exist — needs the
 * tenant's own data and is checked by the mapper, which has it. That is the import's dry-run lesson.
 */
const text = (max: number) => z.coerce.string().trim().max(max);

export const publicLeadSchema = z
  .object({
    /** One name field, split on the last word, as every other channel splits it. */
    name: text(160).optional(),
    firstName: text(80).optional(),
    lastName: text(80).optional(),
    company: text(160).optional(),
    jobTitle: text(120).optional(),
    phone: text(32).optional(),
    whatsapp: text(32).optional(),
    email: text(180).optional(),
    city: text(120).optional(),
    state: text(120).optional(),
    country: text(2).optional(),
    postalCode: text(20).optional(),
    /** Minor units, like everywhere else in this product. */
    valueMinor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    /** What they said. Lands on the lead's timeline, because there is no column for it. */
    message: text(2000).optional(),
    /** The tenant's own source **by name**: an integrator has a name, not a uuid. */
    source: text(120).optional(),
    /** Which form, when a page posted this rather than using the form endpoint. */
    formSlug: text(60).optional(),
    customFields: z.record(z.string().max(120), z.unknown()).optional(),
    utm: z.record(z.string().max(40), z.unknown()).optional(),
    pageUrl: text(2000).optional(),
    referrer: text(2000).optional(),
    visitorId: text(120).optional(),
    sessionId: text(120).optional(),
    consent: z
      .object({
        whatsapp: z.coerce.boolean().optional(),
        email: z.coerce.boolean().optional(),
        calls: z.coerce.boolean().optional(),
        text: text(500).optional(),
      })
      .passthrough()
      .optional(),
    metadata: z.record(z.string().max(120), z.unknown()).optional(),
    /** When the enquiry actually happened, for a batch arriving late. */
    capturedAt: z.coerce.date().optional(),
  })
  // Everything else is kept, not refused (`FR-CAP-5`).
  .passthrough();

export const listPayloadsSchema = z
  .object({
    status: z.enum(INBOUND_STATUSES).optional(),
    channel: z.enum(INGEST_CHANNELS).optional(),
    apiKeyId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  })
  .strict();

export const listIngestionErrorsSchema = z
  .object({
    stage: z.string().trim().max(40).optional(),
    replayable: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  })
  .strict();

/**
 * The self-serve test tool (`FR-CAP-6`).
 *
 * The same payload, run through the same pipeline in dry-run mode: it answers each step's decision
 * — what the values normalised to, what the duplicate rules say, who would be assigned — and
 * persists nothing. "Why did my lead not appear" is the question it exists to answer without a
 * support conversation.
 */
export const testIngestSchema = z.object({ payload: publicLeadSchema }).strict();

export type PublicLeadInput = z.infer<typeof publicLeadSchema>;
export type ListPayloadsQuery = z.infer<typeof listPayloadsSchema>;
export type ListIngestionErrorsQuery = z.infer<typeof listIngestionErrorsSchema>;
export type TestIngestInput = z.infer<typeof testIngestSchema>;
