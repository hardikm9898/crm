import { CSV_DELIMITERS, IMPORT_MODES } from '@leados/shared';
import { z } from 'zod';

/**
 * Request shapes for the import wizard.
 *
 * The file itself is the request body (`text/csv`), so the only thing the upload needs in its query
 * is the file's name — which is metadata about the upload, not part of the data.
 */
export const uploadImportSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    /** Leads today. Declared rather than assumed so a later entity does not change the URL. */
    entityType: z.literal('lead').default('lead'),
    /**
     * Normally sniffed from the file. Overridable because a one-column file has no separator to
     * sniff and a person who knows their file should be able to say so.
     */
    delimiter: z.enum(CSV_DELIMITERS).optional(),
  })
  .strict();
export type UploadImportInput = z.infer<typeof uploadImportSchema>;

export const previewImportSchema = z
  .object({ rows: z.coerce.number().int().min(1).max(50).default(10) })
  .strict();
export type PreviewImportQuery = z.infer<typeof previewImportSchema>;

export const setImportMappingSchema = z
  .object({
    /**
     * Column header → field. A header the person chose to ignore is simply absent, rather than
     * mapped to a sentinel: "unmapped" is the absence of a decision, and encoding it as a value
     * would make an empty string a meaningful field name.
     */
    mapping: z.record(z.string().min(1).max(255), z.string().min(1).max(120)),
    mode: z.enum(IMPORT_MODES),
  })
  .strict();
export type SetImportMappingInput = z.infer<typeof setImportMappingSchema>;

export const listImportsSchema = z
  .object({
    status: z
      .enum([
        'uploaded',
        'mapped',
        'validated',
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
      ])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export type ListImportsQuery = z.infer<typeof listImportsSchema>;

export const listImportRowsSchema = z
  .object({
    status: z.enum(['created', 'updated', 'attached', 'skipped', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** The row number to continue after — a row's own number is the only cursor a person can read. */
    after: z.coerce.number().int().min(0).optional(),
  })
  .strict();
export type ListImportRowsQuery = z.infer<typeof listImportRowsSchema>;
