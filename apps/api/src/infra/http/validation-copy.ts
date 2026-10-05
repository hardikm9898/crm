import * as z from 'zod';

/**
 * Human wording for validation failures.
 *
 * Zod's default messages are written for the developer reading a stack trace: *"Too small: expected
 * string to have >=4 characters"*, *"Invalid input"*, *"Unrecognized key"*. Every one of them
 * reached the user — the pipe maps `issue.message` onto the API's field-error contract, and the web
 * app renders it under the input. That was found by typing a two-digit phone number into the lead
 * form and reading what came back.
 *
 * Fixed here rather than by adding a message to every rule in every DTO, for two reasons: there are
 * several hundred rules and the next one would be forgotten, and a schema that *does* carry its own
 * message keeps it — Zod's global error map only supplies the default. So an endpoint can still say
 * something specific ("Include a phone number, WhatsApp number or email address"), and everything
 * else gets a sentence instead of an assertion.
 *
 * Installed once at boot (`installValidationCopy`). It is global by necessity: the error map belongs
 * to Zod, not to a schema.
 */

/** Field names a person would not recognise, mapped to what they call the thing. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  phone: 'phone number',
  phoneE164: 'phone number',
  whatsapp: 'WhatsApp number',
  whatsappE164: 'WhatsApp number',
  email: 'email address',
  valueMinor: 'value',
  statusId: 'status',
  stageId: 'stage',
  pipelineId: 'pipeline',
  leadSourceId: 'source',
  assignedUserId: 'owner',
  lostReasonId: 'lost reason',
  tagIds: 'tags',
  roleId: 'role',
  teamId: 'team',
  branchId: 'branch',
  maxApplications: 'application limit',
  triggerEvent: 'trigger',
};

function fieldWord(path: readonly PropertyKey[]): string {
  const last = path[path.length - 1];
  if (typeof last === 'number') return 'entry';
  const name = typeof last === 'string' ? last : '';
  if (name === '') return 'value';
  if (FIELD_WORDS[name]) return FIELD_WORDS[name]!;
  // `firstName` → `first name`, `lead_source` → `lead source`.
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]/g, ' ')
    .toLowerCase();
}

function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function listOf(values: readonly unknown[]): string {
  const printable = values.map((value) => String(value));
  if (printable.length <= 4) return printable.join(', ');
  return `${printable.slice(0, 4).join(', ')}, …`;
}

/**
 * One sentence per issue code.
 *
 * Deliberately plain and specific: a message that says what to do is the difference between a form
 * somebody can finish and one they abandon.
 */
function humanise(issue: z.core.$ZodRawIssue): string {
  const subject = fieldWord(issue.path ?? []);

  switch (issue.code) {
    case 'invalid_type': {
      const expected = (issue as { expected?: string }).expected;
      if ((issue as { input?: unknown }).input === undefined) {
        return `${capitalise(subject)} is required.`;
      }
      if (expected === 'number') return `${capitalise(subject)} must be a number.`;
      if (expected === 'boolean') return `${capitalise(subject)} must be yes or no.`;
      if (expected === 'array') return `${capitalise(subject)} must be a list.`;
      if (expected === 'date') return `${capitalise(subject)} must be a date.`;
      return `${capitalise(subject)} is not in the right format.`;
    }

    case 'too_small': {
      const { minimum, origin, inclusive } = issue as {
        minimum?: number | bigint;
        origin?: string;
        inclusive?: boolean;
      };
      const bound = Number(minimum ?? 0);
      if (origin === 'string') {
        if (bound <= 1) return `${capitalise(subject)} cannot be empty.`;
        return `${capitalise(subject)} needs at least ${bound} characters.`;
      }
      if (origin === 'array' || origin === 'set') {
        if (bound <= 1) return `Choose at least one ${subject === 'tags' ? 'tag' : subject}.`;
        return `Choose at least ${bound}.`;
      }
      if (origin === 'date') return `${capitalise(subject)} is too early.`;
      return inclusive === false
        ? `${capitalise(subject)} must be more than ${bound}.`
        : `${capitalise(subject)} must be ${bound} or more.`;
    }

    case 'too_big': {
      const { maximum, origin, inclusive } = issue as {
        maximum?: number | bigint;
        origin?: string;
        inclusive?: boolean;
      };
      const bound = Number(maximum ?? 0);
      if (origin === 'string')
        return `${capitalise(subject)} cannot be longer than ${bound} characters.`;
      if (origin === 'array' || origin === 'set') return `No more than ${bound} may be chosen.`;
      if (origin === 'date') return `${capitalise(subject)} is too late.`;
      return inclusive === false
        ? `${capitalise(subject)} must be less than ${bound}.`
        : `${capitalise(subject)} must be ${bound} or less.`;
    }

    case 'invalid_format': {
      const format = (issue as { format?: string }).format;
      switch (format) {
        case 'email':
          return 'That does not look like an email address.';
        case 'uuid':
        case 'guid':
          return `Choose a ${subject} from the list.`;
        case 'url':
          return 'That does not look like a web address.';
        case 'datetime':
        case 'date':
          return `${capitalise(subject)} must be a date.`;
        case 'regex':
          return `${capitalise(subject)} is not in the expected format.`;
        default:
          return `${capitalise(subject)} is not in the expected format.`;
      }
    }

    case 'invalid_value': {
      const values = (issue as { values?: readonly unknown[] }).values ?? [];
      if (values.length === 1) return `${capitalise(subject)} must be ${String(values[0])}.`;
      if (values.length > 1) return `Choose one of: ${listOf(values)}.`;
      return `${capitalise(subject)} is not one of the allowed values.`;
    }

    case 'unrecognized_keys': {
      const keys = (issue as { keys?: readonly string[] }).keys ?? [];
      // Worth naming: an unexpected key is almost always a typo or a stale client, and saying which
      // one turns a baffling 400 into a one-line fix.
      return keys.length > 0
        ? `${keys.length === 1 ? 'This field is' : 'These fields are'} not accepted here: ${listOf(keys)}.`
        : 'That field is not accepted here.';
    }

    case 'invalid_union':
      return `${capitalise(subject)} is not in any accepted format.`;

    case 'not_multiple_of': {
      const divisor = (issue as { divisor?: number }).divisor;
      return `${capitalise(subject)} must be a multiple of ${divisor ?? 1}.`;
    }

    case 'invalid_element':
    case 'invalid_key':
      return `One of the ${subject} entries is not valid.`;

    case 'custom':
      // A `refine` with no message of its own. Rare, and worth being honest about rather than
      // inventing a reason.
      return `${capitalise(subject)} is not valid.`;

    default:
      return `${capitalise(subject)} is not valid.`;
  }
}

/**
 * Installs the global error map.
 *
 * Called from the bootstrap and from the test harness, so a test asserting on a message sees what a
 * user would see — a convention that holds in production but not in tests is one the tests cannot
 * defend.
 */
export function installValidationCopy(): void {
  z.config({ customError: (issue) => humanise(issue) });
}

/** Exported for the unit test, which is where the wording is actually checked. */
export const humaniseIssue = humanise;
