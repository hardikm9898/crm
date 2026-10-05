import { customFieldSpec } from './custom-fields.js';

/**
 * What a lead export may contain (`FR-IO-3`).
 *
 * A declared catalogue rather than "every column of the table" for two reasons. The first is
 * honesty about personal data: each column says whether it *is* personal data, and that flag is
 * what decides whether an export needs `export:pii` and an audit entry. A column list derived
 * from the schema would silently classify the next column somebody adds as non-personal.
 *
 * The second is that an export is a document a person reads, not a database dump: it carries the
 * *name* of a status, a stage, an owner and a source, not their ids. Nothing downstream of this
 * list has to know how to join.
 */
export interface ExportableColumn {
  readonly key: string;
  readonly label: string;
  /**
   * Personal data about an individual. Phone, email and name are; a status name is not; a city is
   * marked because, with a name, it identifies somebody.
   */
  readonly pii: boolean;
  /** Where the value comes from: the lead's own column, a relation's name, or a custom field. */
  readonly kind: 'column' | 'relation' | 'computed' | 'custom';
}

export const EXPORTABLE_LEAD_COLUMNS: readonly ExportableColumn[] = [
  { key: 'id', label: 'Lead ID', pii: false, kind: 'column' },
  { key: 'fullName', label: 'Full name', pii: true, kind: 'column' },
  { key: 'firstName', label: 'First name', pii: true, kind: 'column' },
  { key: 'lastName', label: 'Last name', pii: true, kind: 'column' },
  { key: 'company', label: 'Company', pii: false, kind: 'column' },
  { key: 'jobTitle', label: 'Job title', pii: false, kind: 'column' },
  { key: 'phone', label: 'Phone', pii: true, kind: 'column' },
  { key: 'whatsapp', label: 'WhatsApp', pii: true, kind: 'column' },
  { key: 'email', label: 'Email', pii: true, kind: 'column' },
  { key: 'city', label: 'City', pii: true, kind: 'column' },
  { key: 'state', label: 'State', pii: false, kind: 'column' },
  { key: 'country', label: 'Country', pii: false, kind: 'column' },
  { key: 'postalCode', label: 'Postal code', pii: true, kind: 'column' },
  { key: 'status', label: 'Status', pii: false, kind: 'relation' },
  { key: 'pipeline', label: 'Pipeline', pii: false, kind: 'relation' },
  { key: 'stage', label: 'Stage', pii: false, kind: 'relation' },
  { key: 'source', label: 'Source', pii: false, kind: 'relation' },
  { key: 'owner', label: 'Owner', pii: false, kind: 'relation' },
  { key: 'tags', label: 'Tags', pii: false, kind: 'relation' },
  { key: 'priority', label: 'Priority', pii: false, kind: 'column' },
  { key: 'score', label: 'Score', pii: false, kind: 'column' },
  { key: 'scoreBand', label: 'Score band', pii: false, kind: 'column' },
  { key: 'value', label: 'Deal value', pii: false, kind: 'computed' },
  { key: 'currency', label: 'Currency', pii: false, kind: 'column' },
  { key: 'createdVia', label: 'Captured via', pii: false, kind: 'column' },
  { key: 'landingPageUrl', label: 'Landing page', pii: false, kind: 'column' },
  { key: 'utmSource', label: 'UTM source', pii: false, kind: 'computed' },
  { key: 'utmMedium', label: 'UTM medium', pii: false, kind: 'computed' },
  { key: 'utmCampaign', label: 'UTM campaign', pii: false, kind: 'computed' },
  { key: 'consentWhatsapp', label: 'WhatsApp consent', pii: false, kind: 'column' },
  { key: 'consentEmail', label: 'Email consent', pii: false, kind: 'column' },
  { key: 'consentCalls', label: 'Call consent', pii: false, kind: 'column' },
  { key: 'createdAt', label: 'Captured on', pii: false, kind: 'column' },
  { key: 'lastActivityAt', label: 'Last activity', pii: false, kind: 'column' },
  { key: 'nextActionAt', label: 'Next action due', pii: false, kind: 'column' },
  { key: 'updatedAt', label: 'Last updated', pii: false, kind: 'column' },
];

/** The columns chosen when a request names none: what a person would put on a spreadsheet. */
export const DEFAULT_EXPORT_COLUMNS: readonly string[] = [
  'fullName',
  'company',
  'phone',
  'email',
  'city',
  'status',
  'stage',
  'source',
  'owner',
  'priority',
  'score',
  'value',
  'tags',
  'createdAt',
];

export interface CustomFieldForExport {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly isPii: boolean;
}

/** The catalogue plus this tenant's custom fields, which carry their own PII flag. */
export function exportableColumns(
  customFields: readonly CustomFieldForExport[] = [],
): readonly ExportableColumn[] {
  const custom: ExportableColumn[] = [];
  for (const definition of customFields) {
    if (!customFieldSpec(definition.type)) continue;
    custom.push({
      key: `custom.${definition.key}`,
      label: definition.label,
      pii: definition.isPii,
      kind: 'custom',
    });
  }
  return [...EXPORTABLE_LEAD_COLUMNS, ...custom];
}

/** True when any chosen column is personal data — the test that makes an export auditable. */
export function exportIncludesPii(
  columns: readonly string[],
  catalogue: readonly ExportableColumn[] = EXPORTABLE_LEAD_COLUMNS,
): boolean {
  const pii = new Set(catalogue.filter((column) => column.pii).map((column) => column.key));
  return columns.some((column) => pii.has(column));
}

/** Columns the catalogue does not contain, so a request can be refused by naming them. */
export function unknownExportColumns(
  columns: readonly string[],
  catalogue: readonly ExportableColumn[] = EXPORTABLE_LEAD_COLUMNS,
): readonly string[] {
  const known = new Set(catalogue.map((column) => column.key));
  return columns.filter((column) => !known.has(column));
}
