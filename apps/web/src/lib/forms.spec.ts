import { describe, expect, it } from 'vitest';
import {
  FORM_HONEYPOT_FIELD as API_HONEYPOT,
  FORM_SUBMISSION_STATUSES as API_STATUSES,
  FORM_TYPES as API_TYPES,
  FORM_STANDARD_FIELDS,
} from '@leados/shared';
import {
  FORM_SUBMISSION_STATUSES,
  FORM_TYPES,
  FORM_TYPE_LABELS,
  HONEYPOT_FIELD,
  SUBMISSION_STATUS_CLASSES,
  SUBMISSION_STATUS_LABELS,
  describeAnswers,
  describeFormActivity,
  embedSnippet,
  publicFormUrl,
  relativeWhen,
  type FormFieldRow,
} from './forms';

/**
 * The reconciliation `lib/forms.ts` exists for.
 *
 * The web app may not import `@leados/shared` at runtime — its entry point reaches
 * `node:async_hooks` and a client component that pulls that in fails `next build` — so the form
 * vocabulary is written twice. This spec runs in Node and may import both.
 *
 * The honeypot's name is the load-bearing one: the renderer writes the field and the API reads it,
 * and a drift would mean every submission looks like a bot or no submission ever does.
 */
describe('the form vocabulary', () => {
  it('matches the API’s, which the runtime code deliberately does not import', () => {
    expect([...FORM_TYPES]).toEqual([...API_TYPES]);
    expect([...FORM_SUBMISSION_STATUSES]).toEqual([...API_STATUSES]);
  });

  it('agrees with the API about the honeypot’s name', () => {
    expect(HONEYPOT_FIELD).toBe(API_HONEYPOT);
  });

  it('has a label and a colour for every status, including the one before an outcome', () => {
    for (const status of FORM_SUBMISSION_STATUSES) {
      expect(SUBMISSION_STATUS_LABELS[status]?.length ?? 0).toBeGreaterThan(0);
      expect(SUBMISSION_STATUS_CLASSES[status]?.length ?? 0).toBeGreaterThan(0);
    }
    for (const type of FORM_TYPES) {
      expect(FORM_TYPE_LABELS[type]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('distinguishes a refusal from a failure, because only one of them is ours', () => {
    expect(SUBMISSION_STATUS_CLASSES.rejected).not.toBe(SUBMISSION_STATUS_CLASSES.error);
  });
});

describe('the public URL and the embed snippet', () => {
  it('uses the key, never the slug — a slug belongs to every workspace that chose it', () => {
    const url = publicFormUrl('https://app.example.test/', 'abcdef0123456789');
    expect(url).toBe('https://app.example.test/f/abcdef0123456789');
    // The slug is not in it at all.
    expect(url).not.toContain('website-enquiry');
  });

  it('embeds as an iframe, with the title escaped', () => {
    const snippet = embedSnippet('https://app.example.test/f/key', 'The "big" enquiry');
    expect(snippet).toContain('<iframe src="https://app.example.test/f/key"');
    expect(snippet).toContain('title="The &quot;big&quot; enquiry"');
    expect(snippet).not.toContain('<script');
  });
});

describe('describeFormActivity', () => {
  it('says plainly when nothing has come in', () => {
    expect(describeFormActivity({ submissionCount: 0, lastSubmissionAt: null })).toBe(
      'Nothing has come in through it yet.',
    );
  });

  it('counts one submission in the singular, which is where this breaks', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    expect(
      describeFormActivity({ submissionCount: 1, lastSubmissionAt: now.toISOString() }),
    ).toContain('1 submission,');
    expect(
      describeFormActivity({ submissionCount: 4, lastSubmissionAt: now.toISOString() }),
    ).toContain('4 submissions,');
  });
});

describe('relativeWhen', () => {
  it('reads as a person would say it', () => {
    const now = new Date('2026-10-14T12:00:00.000Z');
    expect(relativeWhen('2026-10-14T11:59:40.000Z', now)).toBe('just now');
    expect(relativeWhen('2026-10-14T11:59:00.000Z', now)).toBe('1 minute ago');
    expect(relativeWhen('2026-10-14T11:30:00.000Z', now)).toBe('30 minutes ago');
    expect(relativeWhen('2026-10-14T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(relativeWhen('2026-10-12T12:00:00.000Z', now)).toBe('2 days ago');
  });
});

describe('describeAnswers', () => {
  const field = (over: Partial<FormFieldRow>): FormFieldRow => ({
    id: 'f1',
    standardFieldKey: 'phone',
    customFieldDefinitionId: null,
    label: 'Mobile number',
    placeholder: null,
    helpText: null,
    isRequired: true,
    sortOrder: 0,
    stepIndex: 0,
    options: null,
    ...over,
  });

  it('labels an answer with the question it answered', () => {
    const described = describeAnswers({ 'standard:phone': '+919845012345' }, [field({})]);
    expect(described).toEqual([
      { label: 'Mobile number', value: '+919845012345', unmapped: false },
    ]);
  });

  it('keeps an answer to a question that has since been deleted, and marks it', () => {
    // The payload is kept whole precisely so "what did they actually type" has an answer; dropping
    // the orphans would make the record a record of the form instead of the submission.
    const described = describeAnswers({ colour_preference: 'blue' }, [field({})]);
    expect(described).toEqual([{ label: 'colour_preference', value: 'blue', unmapped: true }]);
  });

  it('hides the honeypot, which is not an answer anybody gave', () => {
    expect(describeAnswers({ [HONEYPOT_FIELD]: 'http://spam.example' }, [])).toEqual([]);
  });

  it('reads a custom field’s label from the definition when the form no longer carries it', () => {
    const described = describeAnswers(
      { 'custom:abc': 'interiors' },
      [],
      [
        {
          id: 'abc',
          key: 'service',
          label: 'Which service',
          type: 'select',
          isRequired: false,
          placeholder: null,
          helpText: null,
          options: [],
        },
      ],
    );
    expect(described[0]?.label).toBe('Which service');
    expect(described[0]?.unmapped).toBe(false);
  });

  it('shows the choice the visitor picked, not the value stored under it', () => {
    const described = describeAnswers({ 'custom:abc': 'interiors' }, [
      field({
        standardFieldKey: null,
        customFieldDefinitionId: 'abc',
        label: 'Which service',
        options: [
          { value: 'interiors', label: 'Interiors' },
          { value: 'construction', label: 'Construction' },
        ],
      }),
    ]);
    // "Which service: interiors" is the wire format of somebody's own dropdown, shown to the
    // person who wrote the dropdown. Found by reading the submissions list in a browser.
    expect(described[0]?.value).toBe('Interiors');
  });

  it('falls back to the definition’s choices when the form carries none of its own', () => {
    const described = describeAnswers(
      { 'custom:abc': 'construction' },
      [],
      [
        {
          id: 'abc',
          key: 'service',
          label: 'Which service',
          type: 'select',
          isRequired: false,
          placeholder: null,
          helpText: null,
          options: [
            { value: 'interiors', label: 'Interiors' },
            { value: 'construction', label: 'Construction' },
          ],
        },
      ],
    );
    expect(described[0]?.value).toBe('Construction');
  });

  it('leaves an answer with no choices behind it exactly as it was typed', () => {
    expect(describeAnswers({ 'standard:phone': '98450 12345' }, [field({})])[0]?.value).toBe(
      '98450 12345',
    );
  });

  it('joins a multi-answer into one readable value', () => {
    const described = describeAnswers({ 'custom:abc': ['interiors', 'construction'] }, []);
    expect(described[0]?.value).toBe('interiors, construction');
  });
});

describe('the standard field list the builder offers', () => {
  it('is the API’s list, which is what stops the builder offering a question it will refuse', () => {
    // The web app does not hold its own copy of this list — it reads `/forms/builder-options`,
    // which is served from `FORM_STANDARD_FIELDS`. This asserts the reason that is the right
    // design: the list is a security decision, and a second copy would drift.
    const keys = FORM_STANDARD_FIELDS.map((entry) => entry.key);
    for (const forbidden of ['statusId', 'stageId', 'assignedUserId', 'score', 'leadSourceId']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys).toContain('phone');
  });
});
