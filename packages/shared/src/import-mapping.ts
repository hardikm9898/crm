/**
 * Mapping a spreadsheet's columns onto lead fields (`FR-IO-1`).
 *
 * The importable field list and the guesswork that proposes a mapping live here, pure, because the
 * same answers are needed in three places: the wizard's mapping screen, the validation pass that
 * runs before anything is written, and the import job itself. Three implementations of "which field
 * does the column `Mobile No.` mean" would disagree, and the one that disagreed would be the one
 * that ran.
 *
 * Nothing here touches the database or a custom-field *value*: coercing and validating a value is
 * `custom-field-validation`'s job, and the lead's own columns are validated by the create path. This
 * module decides only **where each column goes**.
 */

import { CUSTOM_FIELD_SPECS, customFieldSpec } from './custom-fields.js';

/** A lead column an import may write. */
export interface ImportableField {
  /** `city`, or `custom.budget`. */
  readonly field: string;
  readonly label: string;
  /** How a cell is read into it. */
  readonly kind: 'text' | 'number' | 'money' | 'date' | 'boolean' | 'enum' | 'reference' | 'tags';
  /** True for the handful an import cannot sensibly do without. */
  readonly required?: boolean;
  /** Other spellings a header might use, lowercased and stripped of punctuation. */
  readonly aliases: readonly string[];
  /** Shown in the wizard under the field. */
  readonly describe?: string;
  /** For `reference` and `enum`: resolved by name, not by id — a spreadsheet has names in it. */
  readonly resolveByName?: 'status' | 'source' | 'stage' | 'owner' | 'tag' | 'lostReason';
}

/**
 * The standard fields, with the aliases real spreadsheets use.
 *
 * The aliases are not decoration: a business exporting from their old CRM gets headers like
 * `Mobile No.`, `Full Name`, `E-mail ID`, `Lead Source`. A mapping screen that proposes nothing
 * leaves a person to pick thirty columns by hand, which is where imports get abandoned.
 */
export const IMPORTABLE_LEAD_FIELDS: readonly ImportableField[] = [
  {
    field: 'firstName',
    label: 'First name',
    kind: 'text',
    aliases: ['first', 'firstname', 'given name', 'givenname', 'fname'],
  },
  {
    field: 'lastName',
    label: 'Last name',
    kind: 'text',
    aliases: ['last', 'lastname', 'surname', 'family name', 'lname'],
  },
  {
    field: 'fullName',
    label: 'Full name',
    kind: 'text',
    aliases: ['name', 'fullname', 'contact name', 'lead name', 'customer name', 'client name'],
    describe: 'Split into first and last name when those are not mapped separately.',
  },
  {
    field: 'phone',
    label: 'Phone',
    kind: 'text',
    aliases: [
      'mobile',
      'mobile no',
      'mobile number',
      'phone no',
      'phone number',
      'contact',
      'contact no',
      'contact number',
      'cell',
      'telephone',
      'tel',
    ],
    describe: 'Normalized to E.164 using the workspace’s country.',
  },
  {
    field: 'whatsapp',
    label: 'WhatsApp',
    kind: 'text',
    aliases: ['whatsapp no', 'whatsapp number', 'wa', 'wa number'],
  },
  {
    field: 'email',
    label: 'Email',
    kind: 'text',
    aliases: ['e mail', 'email id', 'email address', 'mail', 'mail id'],
  },
  {
    field: 'company',
    label: 'Company',
    kind: 'text',
    aliases: ['company name', 'organisation', 'organization', 'firm', 'business'],
  },
  {
    field: 'jobTitle',
    label: 'Job title',
    kind: 'text',
    aliases: ['designation', 'title', 'role'],
  },
  { field: 'city', label: 'City', kind: 'text', aliases: ['town', 'location'] },
  { field: 'state', label: 'State', kind: 'text', aliases: ['province', 'region'] },
  {
    field: 'postalCode',
    label: 'Postal code',
    kind: 'text',
    aliases: ['pincode', 'pin code', 'pin', 'zip', 'zipcode', 'zip code', 'postcode'],
  },
  { field: 'country', label: 'Country', kind: 'text', aliases: ['country code'] },
  {
    field: 'statusId',
    label: 'Status',
    kind: 'reference',
    aliases: ['lead status', 'stage status'],
    resolveByName: 'status',
    describe: 'Matched by name against your statuses. Unknown names are reported, not invented.',
  },
  {
    field: 'stageId',
    label: 'Stage',
    kind: 'reference',
    aliases: ['pipeline stage', 'deal stage'],
    resolveByName: 'stage',
  },
  {
    field: 'leadSourceId',
    label: 'Source',
    kind: 'reference',
    aliases: ['lead source', 'source name', 'channel', 'utm source'],
    resolveByName: 'source',
  },
  {
    field: 'assignedUserId',
    label: 'Owner',
    kind: 'reference',
    aliases: ['owner', 'assigned to', 'assignee', 'sales rep', 'executive', 'agent'],
    resolveByName: 'owner',
    describe: 'Matched by name or email against your members.',
  },
  {
    field: 'priority',
    label: 'Priority',
    kind: 'enum',
    aliases: ['lead priority', 'urgency'],
  },
  {
    field: 'value',
    label: 'Deal value',
    kind: 'money',
    aliases: ['deal value', 'amount', 'budget', 'value', 'potential value', 'expected value'],
    describe: 'A whole amount, in your workspace’s currency.',
  },
  {
    field: 'tags',
    label: 'Tags',
    kind: 'tags',
    aliases: ['tag', 'labels', 'label'],
    resolveByName: 'tag',
    describe: 'Separated by commas or semicolons. Unknown tags are created.',
  },
  {
    field: 'notes',
    label: 'Note',
    kind: 'text',
    aliases: ['note', 'remarks', 'comments', 'description'],
    describe: 'Added to the lead’s timeline rather than to a column.',
  },
  {
    field: 'consentWhatsapp',
    label: 'WhatsApp consent',
    kind: 'boolean',
    aliases: ['whatsapp opt in', 'whatsapp optin', 'wa consent', 'whatsapp permission'],
    describe:
      'Imported as given. Consent is never assumed from the presence of a number — an unmapped column means no consent on record.',
  },
  {
    field: 'consentEmail',
    label: 'Email consent',
    kind: 'boolean',
    aliases: ['email opt in', 'email optin', 'newsletter', 'marketing consent'],
  },
  {
    field: 'consentCalls',
    label: 'Call consent',
    kind: 'boolean',
    aliases: ['call opt in', 'calls allowed', 'can call'],
  },
  {
    field: 'createdAt',
    label: 'Captured on',
    kind: 'date',
    aliases: ['created', 'created on', 'created date', 'date', 'enquiry date', 'lead date'],
    describe:
      'Keeps the original capture date, so reports do not show every old lead as new today.',
  },
];

/** `custom.<key>` entries, built from this tenant's definitions. */
export interface CustomFieldForImport {
  readonly key: string;
  readonly label: string;
  readonly type: string;
}

export function importableFields(
  customFields: readonly CustomFieldForImport[] = [],
): readonly ImportableField[] {
  const custom: ImportableField[] = [];
  for (const definition of customFields) {
    const spec = customFieldSpec(definition.type);
    if (!spec) continue;
    custom.push({
      field: `custom.${definition.key}`,
      label: definition.label,
      kind: kindForType(definition.type),
      aliases: [definition.key.replace(/_/g, ' ')],
      ...(spec.multiValue ? { describe: 'Separated by commas or semicolons.' } : {}),
    });
  }
  return [...IMPORTABLE_LEAD_FIELDS, ...custom];
}

function kindForType(type: string): ImportableField['kind'] {
  const spec = CUSTOM_FIELD_SPECS[type as keyof typeof CUSTOM_FIELD_SPECS];
  if (!spec) return 'text';
  switch (spec.storage) {
    case 'number':
      return type === 'currency' ? 'money' : 'number';
    case 'boolean':
      return 'boolean';
    case 'string[]':
      return 'tags';
    case 'object':
      return type === 'currency' ? 'money' : 'text';
    default:
      return type === 'date' || type === 'datetime' ? 'date' : 'text';
  }
}

/** Strips case, punctuation and spacing so `Mobile No.` and `mobile_no` compare equal. */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface ProposedMapping {
  /** Column header → field, for the columns a field was found for. */
  readonly mapping: Readonly<Record<string, string>>;
  /** Headers nothing was proposed for, so the wizard can show them unmapped rather than hide them. */
  readonly unmatched: readonly string[];
  /** Fields more than one column claimed, which a person has to resolve. */
  readonly ambiguous: readonly { readonly field: string; readonly headers: readonly string[] }[];
}

/**
 * Proposes a mapping from a file's headers.
 *
 * Exact label or field match first, then aliases. A field is proposed **once**: if two columns both
 * look like the phone number, neither is guessed — reporting the ambiguity is better than silently
 * importing the fax number as the mobile.
 */
export function proposeMapping(
  headers: readonly string[],
  fields: readonly ImportableField[] = IMPORTABLE_LEAD_FIELDS,
): ProposedMapping {
  const byNormalized = new Map<string, string>();
  const byCompact = new Map<string, string>();
  const remember = (text: string, field: string): void => {
    const normalized = normalizeHeader(text);
    if (normalized === '') return;
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, field);
    // A second, space-stripped index. `E-mail ID` normalizes to `e mail id`, which no sensible
    // alias list contains — but compacted both sides give `emailid`. That one extra pass covers
    // every hyphenation and spacing variant at once, instead of enumerating them and still missing
    // the next one.
    const compact = normalized.replace(/ /g, '');
    if (!byCompact.has(compact)) byCompact.set(compact, field);
  };
  for (const field of fields) {
    remember(field.field, field.field);
    remember(field.label, field.field);
    for (const alias of field.aliases) remember(alias, field.field);
  }

  const claims = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (const header of headers) {
    if (header.trim() === '') continue;
    const normalized = normalizeHeader(header);
    const candidate = byNormalized.get(normalized) ?? byCompact.get(normalized.replace(/ /g, ''));
    if (!candidate) {
      unmatched.push(header);
      continue;
    }
    claims.set(candidate, [...(claims.get(candidate) ?? []), header]);
  }

  const mapping: Record<string, string> = {};
  const ambiguous: { field: string; headers: string[] }[] = [];
  for (const [field, claimants] of claims) {
    if (claimants.length === 1) mapping[claimants[0]!] = field;
    else {
      ambiguous.push({ field, headers: claimants });
      for (const header of claimants) unmatched.push(header);
    }
  }
  return { mapping, unmatched, ambiguous };
}

export interface MappingProblem {
  readonly code: string;
  readonly message: string;
  readonly header?: string;
  readonly field?: string;
}

/**
 * Checks a mapping before an import is allowed to run.
 *
 * The refusal that matters is the last one: a file with no way to identify a person produces rows
 * that cannot be deduplicated, cannot be called, and cannot be matched to anything later. Importing
 * ten thousand of those is worse than importing none, and it is not undoable by hand.
 */
export function validateMapping(
  mapping: Readonly<Record<string, string>>,
  headers: readonly string[],
  fields: readonly ImportableField[] = IMPORTABLE_LEAD_FIELDS,
): readonly MappingProblem[] {
  const problems: MappingProblem[] = [];
  const known = new Set(fields.map((field) => field.field));
  const headerSet = new Set(headers);
  const targets = new Map<string, string[]>();

  for (const [header, field] of Object.entries(mapping)) {
    if (!headerSet.has(header)) {
      problems.push({
        code: 'UNKNOWN_COLUMN',
        header,
        message: `The file has no column called “${header}”.`,
      });
      continue;
    }
    if (!known.has(field)) {
      problems.push({
        code: 'UNKNOWN_FIELD',
        header,
        field,
        message: `“${field}” is not a field an import can fill.`,
      });
      continue;
    }
    targets.set(field, [...(targets.get(field) ?? []), header]);
  }

  for (const [field, claimants] of targets) {
    if (claimants.length > 1) {
      problems.push({
        code: 'DUPLICATE_TARGET',
        field,
        message: `${claimants.join(' and ')} are both mapped to the same field.`,
      });
    }
  }

  const mapped = new Set(targets.keys());
  const hasName = mapped.has('fullName') || mapped.has('firstName') || mapped.has('lastName');
  const hasIdentifier = mapped.has('phone') || mapped.has('whatsapp') || mapped.has('email');
  if (!hasName) {
    problems.push({
      code: 'NO_NAME',
      message: 'Map a column to a name, or the imported leads cannot be told apart.',
    });
  }
  if (!hasIdentifier) {
    problems.push({
      code: 'NO_IDENTIFIER',
      message:
        'Map a phone number, WhatsApp number or email address. Without one, these leads cannot be ' +
        'deduplicated or contacted, and nothing later can match them to this person.',
    });
  }
  return problems;
}

/** What an import does when a row matches a lead that already exists (`FR-IO-2`). */
export const IMPORT_MODES = ['create_only', 'skip_existing', 'update_existing'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export interface ImportModeSpec {
  readonly mode: ImportMode;
  readonly label: string;
  readonly describe: string;
}

export const IMPORT_MODE_SPECS: Readonly<Record<ImportMode, ImportModeSpec>> = {
  create_only: {
    mode: 'create_only',
    label: 'Let the duplicate rules decide',
    describe:
      'Each row goes through the same duplicate rules as any other capture — usually attaching to ' +
      'the existing lead rather than creating a second one.',
  },
  skip_existing: {
    mode: 'skip_existing',
    label: 'Skip anyone already here',
    describe:
      'A row matching an existing lead is reported as skipped and nothing about it changes.',
  },
  update_existing: {
    mode: 'update_existing',
    label: 'Update anyone already here',
    describe:
      'A row matching an existing lead fills in blanks and overwrites the fields the file maps. ' +
      'Use it to bring a corrected export back in.',
  },
};

/** Splits a multi-value cell the way a person writes one. */
export function splitList(value: string): string[] {
  return value
    .split(/[,;|]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Reads a date the way spreadsheets write them.
 *
 * `dd/mm/yyyy` is assumed over `mm/dd/yyyy` because this product's market writes the former, and
 * the ambiguity is reported rather than guessed when the day could be either — a file whose dates
 * are silently transposed for eleven months of the year is worse than one that refuses.
 */
export function parseSpreadsheetDate(value: string): { date: Date | null; ambiguous: boolean } {
  const text = value.trim();
  if (text === '') return { date: null, ambiguous: false };

  // A trailing time is dropped before the day-first reading. Spreadsheets export
  // `14/02/2026 10:30` constantly, and without this the whole value fell through to `new Date()`,
  // which reads a day-first date as invalid — so every dated row in such a file failed.
  const slashed =
    /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?.*)?$/.exec(text);
  if (slashed) {
    const [, first, second, year] = slashed as unknown as [string, string, string, string];
    const day = Number(first);
    const month = Number(second);
    const fullYear = year.length === 2 ? 2000 + Number(year) : Number(year);
    if (day > 31 || month > 12) {
      // Unambiguously the other way round, so read it that way rather than refusing.
      if (month <= 31 && day <= 12) {
        return { date: utcDate(fullYear, day, month), ambiguous: false };
      }
      return { date: null, ambiguous: false };
    }
    return {
      date: utcDate(fullYear, month, day),
      ambiguous: day <= 12 && month <= 12 && day !== month,
    };
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? { date: null, ambiguous: false }
    : { date: parsed, ambiguous: false };
}

function utcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February, which `Date.UTC` rolls over into March rather than refusing.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** Reads the handful of ways a spreadsheet says yes. */
export function parseBoolean(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'haan'].includes(text)) return true;
  if (['no', 'n', 'false', '0', 'nahi'].includes(text)) return false;
  return null;
}

/**
 * Reads a number from a cell a person formatted.
 *
 * `₹ 12,50,000.00` and `1.250,00` are both real; thousands separators and a currency symbol are
 * stripped, and a comma used as a decimal separator is recognised by position.
 */
export function parseAmount(value: string): number | null {
  let text = value.trim().replace(/[^\d,.-]/g, '');
  if (text === '') return null;

  // Which separator is the decimal point, decided by evidence rather than by locale:
  //
  //  * both present → the **later** one is the decimal point and the other groups
  //    (`1.250,00` is European, `1,250.00` is not);
  //  * commas only → a single comma with one or two digits after it is a decimal point
  //    (`99,99`), and anything else groups. That last part matters more here than most places,
  //    because Indian lakh grouping writes 1,250,000 as `12,50,000` — several commas, the last of
  //    them three digits from the end, which a plain "comma means decimal" rule reads as 12.5.
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const commas = (text.match(/,/g) ?? []).length;
    text = commas === 1 && /,\d{1,2}$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');
  }

  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}
