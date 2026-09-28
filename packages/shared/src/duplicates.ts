/**
 * Duplicate matching (`FR-DUP-1`).
 *
 * The registry below is the single answer to "which fields can a rule match on, and how are two
 * values of that field compared". It matters because the comparison is not obvious and getting it
 * wrong is silent: `+919876543210` and `9876543210` are the same person, `Anita@x.test` and
 * `anita@x.test` are the same mailbox, and "Sharma Motors" and "sharma motors  " are the same firm.
 * A rule that compared raw strings would simply never fire, and a business would conclude that
 * duplicate detection does not work rather than that it was configured against the wrong column.
 */

/** How two values of a field are compared before they count as a match. */
export type MatchComparison =
  /** Byte-for-byte. Used for values already canonicalized on write, like E.164 phones. */
  | 'exact'
  /** Trimmed and lowercased. */
  | 'insensitive'
  /** Trimmed, lowercased, and internal whitespace collapsed. For names and company names. */
  | 'normalized';

export interface MatchableField {
  /** The key a rule names, which is also the lead column. */
  readonly field: string;
  readonly label: string;
  readonly comparison: MatchComparison;
  /**
   * How much this field alone tells you. A phone number is nearly an identifier; a first name is
   * nearly nothing. Used to score a match's confidence so a person can triage a queue.
   */
  readonly weight: number;
  /** False for fields too weak to be a rule's only criterion. */
  readonly sufficientAlone: boolean;
  /**
   * Other columns whose value counts as this field's value when comparing.
   *
   * The phone columns are aliases of each other, because "the same number in a different box" is
   * the same person: a lead captured from a form has `phone_e164`, the same person messaging on
   * WhatsApp arrives as `whatsapp_e164`, and a rule matching on `phoneE164` has to see that. The
   * candidate query already looks in both columns for either value; without the alias here it
   * would fetch the right lead and then reject it. Aliases must share this field's `comparison`.
   */
  readonly aliasFields?: readonly string[];
}

export const MATCHABLE_FIELDS: readonly MatchableField[] = [
  {
    field: 'phoneE164',
    label: 'Phone number',
    comparison: 'exact',
    weight: 50,
    sufficientAlone: true,
    aliasFields: ['whatsappE164'],
  },
  {
    field: 'whatsappE164',
    label: 'WhatsApp number',
    comparison: 'exact',
    weight: 50,
    sufficientAlone: true,
    aliasFields: ['phoneE164'],
  },
  {
    field: 'email',
    label: 'Email address',
    comparison: 'insensitive',
    weight: 45,
    sufficientAlone: true,
  },
  {
    field: 'fullName',
    label: 'Full name',
    comparison: 'normalized',
    weight: 20,
    sufficientAlone: false,
  },
  {
    field: 'lastName',
    label: 'Surname',
    comparison: 'normalized',
    weight: 10,
    sufficientAlone: false,
  },
  {
    field: 'firstName',
    label: 'First name',
    comparison: 'normalized',
    weight: 8,
    sufficientAlone: false,
  },
  {
    field: 'company',
    label: 'Company',
    comparison: 'normalized',
    weight: 15,
    sufficientAlone: false,
  },
  { field: 'city', label: 'City', comparison: 'normalized', weight: 5, sufficientAlone: false },
  {
    field: 'postalCode',
    label: 'Postal code',
    comparison: 'insensitive',
    weight: 8,
    sufficientAlone: false,
  },
];

const FIELD_BY_NAME = new Map(MATCHABLE_FIELDS.map((entry) => [entry.field, entry]));

export function matchableField(field: string): MatchableField | undefined {
  return FIELD_BY_NAME.get(field);
}

/** The comparison form of a value, or `null` when there is nothing to compare. */
export function matchKey(field: string, value: unknown): string | null {
  const definition = FIELD_BY_NAME.get(field);
  if (!definition) return null;
  return compare(definition.comparison, value);
}

function compare(comparison: MatchComparison, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  switch (comparison) {
    case 'exact':
      return trimmed;
    case 'insensitive':
      return trimmed.toLowerCase();
    case 'normalized':
      return trimmed.toLowerCase().replace(/\s+/g, ' ');
  }
}

/**
 * Every comparable value a record offers for one field: the field's own, plus its aliases'.
 *
 * Returned as a set because a lead may carry a different number in each phone column, and either
 * of them matching the capture is a match.
 */
export function matchKeys(field: string, record: Readonly<Record<string, unknown>>): Set<string> {
  const definition = FIELD_BY_NAME.get(field);
  const keys = new Set<string>();
  if (!definition) return keys;
  for (const name of [field, ...(definition.aliasFields ?? [])]) {
    // The named field's comparison, not the alias's: aliases share it by construction, and a
    // registry that broke that would silently compare a normalized value against an exact one.
    const key = compare(definition.comparison, record[name]);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/**
 * A rule's criteria: a list of field sets, read as "any of these sets, all fields within a set".
 *
 * `[["phoneE164"], ["email", "lastName"]]` is "the same phone, **or** the same email and surname".
 * A list of sets rather than a boolean expression because that is how a business states it, and
 * because each set maps to one indexed lookup.
 */
export type MatchOn = readonly (readonly string[])[];

export interface MatchOnProblem {
  readonly setIndex: number;
  readonly code: string;
  readonly message: string;
}

/**
 * Checks a rule's criteria before it is stored.
 *
 * The important refusal is the last one: a set made only of weak fields — `["city"]`, or
 * `["firstName", "city"]` — would match half a tenant's database and quietly start merging
 * strangers. It is refused at configuration time, where someone can still see why.
 */
export function validateMatchOn(matchOn: unknown): readonly MatchOnProblem[] {
  const problems: MatchOnProblem[] = [];
  if (!Array.isArray(matchOn) || matchOn.length === 0) {
    return [
      {
        setIndex: -1,
        code: 'EMPTY',
        message: 'A rule needs at least one set of fields to match on.',
      },
    ];
  }

  for (const [setIndex, set] of matchOn.entries()) {
    if (!Array.isArray(set) || set.length === 0) {
      problems.push({
        setIndex,
        code: 'EMPTY_SET',
        message: 'Each entry must list at least one field.',
      });
      continue;
    }

    const unknown = set.filter((field) => typeof field !== 'string' || !FIELD_BY_NAME.has(field));
    if (unknown.length > 0) {
      problems.push({
        setIndex,
        code: 'UNKNOWN_FIELD',
        message: `Not matchable: ${unknown.join(', ')}. Available: ${MATCHABLE_FIELDS.map(
          (entry) => entry.field,
        ).join(', ')}`,
      });
      continue;
    }

    const fields = set as readonly string[];
    if (new Set(fields).size !== fields.length) {
      problems.push({
        setIndex,
        code: 'DUPLICATE_FIELD',
        message: 'A field is repeated in one set.',
      });
      continue;
    }

    const strength = fields.reduce(
      (total, field) => total + (FIELD_BY_NAME.get(field)?.weight ?? 0),
      0,
    );
    const hasIdentifier = fields.some(
      (field) => FIELD_BY_NAME.get(field)?.sufficientAlone === true,
    );
    if (!hasIdentifier && strength < 30) {
      problems.push({
        setIndex,
        code: 'TOO_WEAK',
        message:
          `Matching on ${fields.join(' + ')} alone would group unrelated people. ` +
          'Include a phone number, WhatsApp number or email address, or add more fields.',
      });
    }
  }

  return problems;
}

/** 0–100. Capped, because a match on four weak fields is still not a certainty. */
export function confidenceFor(matchedFields: readonly string[]): number {
  const total = matchedFields.reduce(
    (sum, field) => sum + (FIELD_BY_NAME.get(field)?.weight ?? 0),
    0,
  );
  const hasIdentifier = matchedFields.some(
    (field) => FIELD_BY_NAME.get(field)?.sufficientAlone === true,
  );
  // An identifier match starts high; a pile of weak fields does not get there by accumulation.
  const ceiling = hasIdentifier ? 100 : 85;
  return Math.max(1, Math.min(ceiling, Math.round(total * 1.6)));
}

/**
 * Whether a candidate matches an existing lead under one field set, and on which fields.
 *
 * Every field in the set must have a comparable value on **both** sides. A candidate with no email
 * must not match an existing lead with no email on the strength of both being empty — that would
 * make every anonymous enquiry a duplicate of every other.
 *
 * The matched fields are reported under the name the *rule* used, even when the values were found
 * in an alias column, so the explanation a manager reads names their own rule back to them.
 */
export function matchSet(
  fields: readonly string[],
  candidate: Readonly<Record<string, unknown>>,
  existing: Readonly<Record<string, unknown>>,
): readonly string[] | null {
  const matched: string[] = [];
  for (const field of fields) {
    const left = matchKeys(field, candidate);
    if (left.size === 0) return null;
    const right = matchKeys(field, existing);
    if (![...left].some((key) => right.has(key))) return null;
    matched.push(field);
  }
  return matched.length > 0 ? matched : null;
}

/** The first set of a rule that matches, with the fields that did. */
export function matchRule(
  matchOn: MatchOn,
  candidate: Readonly<Record<string, unknown>>,
  existing: Readonly<Record<string, unknown>>,
): readonly string[] | null {
  for (const set of matchOn) {
    const matched = matchSet(set, candidate, existing);
    if (matched) return matched;
  }
  return null;
}
