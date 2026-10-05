import {
  customFieldSpec,
  normalizeHeader,
  normalizePhone,
  parseAmount,
  parseBoolean,
  parseSpreadsheetDate,
  splitList,
  type CountryCode,
  type FieldError,
} from '@leados/shared';
import type { ImportCatalogue } from './import-catalogue.service.js';

/**
 * One spreadsheet row → the fields of a lead.
 *
 * Pure, and deliberately so: the whole of "what does this cell mean" is testable without a
 * database, a tenant context or a queue, and the wizard's dry run and the real run therefore
 * cannot disagree. Everything that needs the database — resolving a name to an id — was already
 * resolved into the catalogue before the first row was read.
 *
 * The mapper produces a *draft*, not a validated input. Validation is the lead schema's job
 * (`createLeadSchema` / `updateLeadSchema`), which the runner applies next: an import must accept
 * exactly what the API accepts, and a second opinion about email syntax here would be a second
 * contract to keep in step. What the mapper does own is everything the lead API has no equivalent
 * for — a status *name*, a day-first date, `1,25,000`, `Yes`, a semicolon-separated tag list — and
 * the errors it raises are about the spreadsheet, not about the lead.
 */
export interface MappedImportRow {
  /** Keys of `createLeadSchema`/`updateLeadSchema`, ready to be parsed. */
  readonly draft: Record<string, unknown>;
  readonly customValues: Record<string, unknown>;
  readonly tagNames: readonly string[];
  /** Goes on the timeline rather than into a column (`notes` has no lead field). */
  readonly note: string | null;
  /** The original capture date, applied after creation. */
  readonly capturedAt: Date | null;
  readonly errors: readonly FieldError[];
  /** True when every mapped cell was blank — a trailing line, not a failure. */
  readonly isBlank: boolean;
}

export interface MapRowOptions {
  /** Column header → field, as the wizard saved it. */
  readonly mapping: Readonly<Record<string, string>>;
  readonly catalogue: ImportCatalogue;
}

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export function mapImportRow(
  record: Readonly<Record<string, string>>,
  options: MapRowOptions,
): MappedImportRow {
  const { mapping, catalogue } = options;
  const draft: Record<string, unknown> = {};
  const customValues: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  const tagNames: string[] = [];
  let note: string | null = null;
  let capturedAt: Date | null = null;
  let anyValue = false;

  const fieldsSeen = new Set(Object.values(mapping));

  for (const [header, field] of Object.entries(mapping)) {
    const cell = (record[header] ?? '').trim();
    if (cell !== '') anyValue = true;
    if (cell === '') continue;

    if (field.startsWith('custom.')) {
      const key = field.slice('custom.'.length);
      const definition = catalogue.customFields.find((candidate) => candidate.key === key);
      if (!definition) {
        errors.push({
          field,
          code: 'UNKNOWN_FIELD',
          message: `“${header}” is mapped to a field that no longer exists.`,
        });
        continue;
      }
      // Custom values go in as text and are coerced by `validateCustomValues`, which owns every
      // type's rules — except the multi-value types, where the spreadsheet convention (one cell,
      // separated) has to be turned into a list before that code can see it.
      const spec = customFieldSpec(definition.type);
      customValues[key] = spec?.multiValue === true ? splitList(cell) : cell;
      continue;
    }

    switch (field) {
      case 'firstName':
      case 'lastName':
      case 'company':
      case 'jobTitle':
      case 'email':
      case 'city':
      case 'state':
      case 'postalCode':
        draft[field] = cell;
        break;

      case 'phone':
      case 'whatsapp': {
        // Checked here, though `LeadsService` is still the one that normalizes: the dry run has to
        // be able to say "row 4's phone number is not a phone number" *before* the import, and
        // `createLeadSchema` only knows the string is between 4 and 32 characters long. Without
        // this, a file full of `not-a-phone` reported as five rows ready to import and then failed
        // five rows at import time — which is exactly the dishonesty a dry run exists to prevent.
        // The raw text is what travels on, so normalization still happens in one place.
        try {
          normalizePhone(cell, catalogue.defaultPhoneCountry as CountryCode);
          draft[field] = cell;
        } catch {
          errors.push({
            field,
            code: 'INVALID_PHONE',
            message: `“${cell}” is not a phone number we can read.`,
          });
        }
        break;
      }

      case 'country':
        // A two-letter code is what the column means; a full country name is a different column
        // and silently truncating "India" to "IN" by taking two characters would be a lie.
        if (/^[A-Za-z]{2}$/.test(cell)) draft['country'] = cell.toUpperCase();
        else
          errors.push({
            field: 'country',
            code: 'INVALID_COUNTRY',
            message: `“${cell}” is not a two-letter country code (for example IN or AE).`,
          });
        break;

      case 'fullName': {
        // Only used for the halves nothing else filled: an explicit First name column always wins.
        const split = splitFullName(cell);
        if (!fieldsSeen.has('firstName') && split.firstName) draft['firstName'] = split.firstName;
        if (!fieldsSeen.has('lastName') && split.lastName) draft['lastName'] = split.lastName;
        break;
      }

      case 'priority': {
        const value = normalizeHeader(cell);
        const matched = PRIORITIES.find((candidate) => candidate === value);
        if (matched) draft['priority'] = matched;
        else
          errors.push({
            field: 'priority',
            code: 'UNKNOWN_PRIORITY',
            message: `“${cell}” is not a priority. Use low, medium, high or urgent.`,
          });
        break;
      }

      case 'statusId': {
        const id = catalogue.statuses.get(normalizeHeader(cell));
        if (id) draft['statusId'] = id;
        else
          errors.push(unknownReference('statusId', header, cell, 'status', catalogue.statusNames));
        break;
      }

      case 'stageId': {
        const stage = catalogue.stages.get(normalizeHeader(cell));
        if (stage) {
          draft['stageId'] = stage.id;
          // The pipeline is implied by the stage, and saying so explicitly is what keeps
          // `leads_stage_in_pipeline_fk` satisfiable without the service having to guess.
          draft['pipelineId'] = stage.pipelineId;
        } else {
          errors.push(unknownReference('stageId', header, cell, 'stage', catalogue.stageNames));
        }
        break;
      }

      case 'leadSourceId': {
        const id = catalogue.sources.get(normalizeHeader(cell));
        if (id) draft['leadSourceId'] = id;
        else
          errors.push(
            unknownReference('leadSourceId', header, cell, 'source', catalogue.sourceNames),
          );
        break;
      }

      case 'assignedUserId': {
        const id = catalogue.owners.get(normalizeHeader(cell));
        if (id) draft['assignedUserId'] = id;
        else
          errors.push({
            field: 'assignedUserId',
            code: 'UNKNOWN_OWNER',
            message: `“${cell}” does not match a member of this workspace, by name or email address.`,
          });
        break;
      }

      case 'value': {
        const amount = parseAmount(cell);
        if (amount === null) {
          errors.push({
            field: 'valueMinor',
            code: 'INVALID_AMOUNT',
            message: `“${cell}” is not an amount.`,
          });
          break;
        }
        // The column is a whole amount in the workspace's currency; the database stores minor units.
        draft['valueMinor'] = Math.round(amount * 100);
        draft['currency'] = catalogue.defaultCurrency;
        break;
      }

      case 'tags':
        tagNames.push(...splitList(cell));
        break;

      case 'notes':
        note = cell.slice(0, 5_000);
        break;

      case 'createdAt': {
        const parsed = parseSpreadsheetDate(cell);
        if (!parsed.date) {
          errors.push({
            field: 'createdAt',
            code: 'INVALID_DATE',
            message: `“${cell}” is not a date. Use DD/MM/YYYY or YYYY-MM-DD.`,
          });
          break;
        }
        if (parsed.date.getTime() > Date.now() + 24 * 3_600_000) {
          errors.push({
            field: 'createdAt',
            code: 'FUTURE_DATE',
            message: `“${cell}” is in the future, so it cannot be when this lead was captured.`,
          });
          break;
        }
        capturedAt = parsed.date;
        break;
      }

      case 'consentWhatsapp':
      case 'consentEmail':
      case 'consentCalls': {
        const value = parseBoolean(cell);
        if (value === null) {
          errors.push({
            field,
            code: 'INVALID_BOOLEAN',
            message: `“${cell}” is not a yes or a no.`,
          });
          break;
        }
        const consent = (draft['consent'] ?? {}) as Record<string, boolean>;
        consent[
          field === 'consentWhatsapp' ? 'whatsapp' : field === 'consentEmail' ? 'email' : 'calls'
        ] = value;
        draft['consent'] = consent;
        break;
      }

      default:
        errors.push({
          field,
          code: 'UNKNOWN_FIELD',
          message: `“${header}” is mapped to “${field}”, which is not a field that can be imported.`,
        });
    }
  }

  return {
    draft,
    customValues,
    tagNames,
    note,
    capturedAt,
    errors,
    isBlank: !anyValue,
  };
}

/** `Priya Sharma Nair` → first `Priya Sharma`, last `Nair`; a single word is a first name. */
export function splitFullName(value: string): { firstName: string; lastName: string | null } {
  const parts = value.split(/\s+/).filter((part) => part !== '');
  if (parts.length <= 1) return { firstName: parts[0] ?? '', lastName: null };
  const lastName = parts.pop() as string;
  return { firstName: parts.join(' '), lastName };
}

/**
 * The error for a name that matched nothing.
 *
 * It names a few of the values that *would* have matched, because "unknown status" tells a person
 * nothing they can act on and the list is what turns the failure into a fix.
 */
function unknownReference(
  field: string,
  header: string,
  cell: string,
  what: string,
  known: readonly string[],
): FieldError {
  const examples = known.slice(0, 5).join(', ');
  return {
    field,
    code: 'UNKNOWN_REFERENCE',
    message:
      `“${cell}” in column “${header}” does not match any ${what} in this workspace.` +
      (examples ? ` Yours are: ${examples}${known.length > 5 ? ', …' : ''}.` : ''),
  };
}
