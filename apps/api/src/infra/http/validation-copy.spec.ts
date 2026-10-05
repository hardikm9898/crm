import { beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { installValidationCopy } from './validation-copy.js';

/**
 * The wording a person reads when a form is refused.
 *
 * Asserted through real schemas rather than by calling the humaniser directly, because what matters
 * is the message that comes out of `safeParse` — which is where Zod decides between its default and
 * a schema's own.
 */
beforeAll(() => {
  installValidationCopy();
});

const messageFor = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  expect(result.success, `expected ${JSON.stringify(value)} to be refused`).toBe(false);
  return result.success ? '' : (result.error.issues[0]?.message ?? '');
};

describe('no Zod internals reach a user', () => {
  const schema = z
    .object({
      firstName: z.string().min(1).max(80),
      phone: z.string().min(4).max(32).optional(),
      email: z.string().email().optional(),
      statusId: z.string().uuid().optional(),
      score: z.coerce.number().int().min(0).max(1000).optional(),
      tagIds: z.array(z.string().uuid()).min(1).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    })
    .strict();

  const cases: { name: string; value: unknown; expect: RegExp }[] = [
    { name: 'a missing required field', value: {}, expect: /^First name is required\.$/ },
    { name: 'an empty string', value: { firstName: '' }, expect: /^First name cannot be empty\.$/ },
    {
      name: 'a value that is too long',
      value: { firstName: 'x'.repeat(81) },
      expect: /^First name cannot be longer than 80 characters\.$/,
    },
    {
      name: 'a phone number that is too short, named as a person would name it',
      value: { firstName: 'A', phone: '12' },
      expect: /^Phone number needs at least 4 characters\.$/,
    },
    {
      name: 'a malformed email',
      value: { firstName: 'A', email: 'nope' },
      expect: /email address/,
    },
    {
      name: 'an id that is not an id',
      value: { firstName: 'A', statusId: 'new' },
      expect: /^Choose a status from the list\.$/,
    },
    {
      name: 'a number out of range',
      value: { firstName: 'A', score: 5000 },
      expect: /^Score must be 1000 or less\.$/,
    },
    {
      name: 'a number where text was sent',
      value: { firstName: 'A', score: 'hot' },
      expect: /^Score must be a number\.$/,
    },
    {
      name: 'an empty list where one choice is needed',
      value: { firstName: 'A', tagIds: [] },
      expect: /^Choose at least one tag\.$/,
    },
    {
      name: 'a value outside an enum, listing the options',
      value: { firstName: 'A', priority: 'burning' },
      expect: /^Choose one of: low, medium, high, urgent\.$/,
    },
    {
      name: 'an unexpected field, named so the typo is obvious',
      value: { firstName: 'A', frstName: 'A' },
      expect: /not accepted here: frstName/,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const message = messageFor(schema, testCase.value);
      expect(message).toMatch(testCase.expect);
      // The actual regression: Zod's own phrasing, which is written for a stack trace.
      expect(message).not.toMatch(/expected|Invalid input|Unrecognized key|>=|<=/);
    });
  }

  it('ends every message as a sentence', () => {
    for (const testCase of cases) {
      const message = messageFor(schema, testCase.value);
      expect(message, testCase.name).toMatch(/[.!?]$/);
      expect(message[0], testCase.name).toBe(message[0]?.toUpperCase());
    }
  });
});

describe('a schema that says something specific keeps saying it', () => {
  it('prefers the message the endpoint wrote', () => {
    // The whole reason this is an error map rather than a rewrite of every DTO.
    const schema = z.object({
      matchOn: z
        .array(z.string())
        .min(1, 'Include a phone number, WhatsApp number or email address.'),
    });
    expect(messageFor(schema, { matchOn: [] })).toBe(
      'Include a phone number, WhatsApp number or email address.',
    );
  });

  it('keeps a custom refine message', () => {
    const schema = z
      .object({ leadId: z.string().optional(), lead: z.unknown().optional() })
      .refine((value) => value.leadId !== undefined || value.lead !== undefined, {
        message: 'Give a leadId or a lead to score',
      });
    expect(messageFor(schema, {})).toBe('Give a leadId or a lead to score');
  });
});

describe('field names are translated, not echoed', () => {
  it('turns a camelCase column into words', () => {
    const schema = z.object({ postalCode: z.string().min(1) });
    expect(messageFor(schema, { postalCode: '' })).toBe('Postal code cannot be empty.');
  });

  it('uses the word a business uses for the ones a developer named', () => {
    for (const [field, word] of [
      ['whatsappE164', 'WhatsApp number'],
      ['valueMinor', 'value'],
      ['leadSourceId', 'source'],
      ['assignedUserId', 'owner'],
    ] as const) {
      const schema = z.object({ [field]: z.string().min(2) });
      expect(messageFor(schema, { [field]: '' }).toLowerCase()).toContain(word.toLowerCase());
    }
  });

  it('describes a failure inside a list without saying "0"', () => {
    const schema = z.object({ tagIds: z.array(z.string().uuid()) });
    const message = messageFor(schema, { tagIds: ['nope'] });
    expect(message).not.toContain('0');
    expect(message.length).toBeGreaterThan(0);
  });
});
