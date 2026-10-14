import { describe, expect, it } from 'vitest';
import {
  FORM_HONEYPOT_FIELD,
  FORM_STANDARD_FIELDS,
  formFieldName,
  formStandardField,
  isHoneypotTripped,
  normalizeUtm,
  validateFormSubmission,
  type FormFieldView,
} from './forms.js';
import { IMPORTABLE_LEAD_FIELDS } from './import-mapping.js';

/**
 * The form vocabulary, and the validation a stranger's answers go through.
 *
 * The first block is the one that matters for security rather than for copy: a public form may ask
 * only for things a stranger is allowed to set, and the day somebody adds `status` or `assignedUser`
 * to the standard list, this suite is what refuses it.
 */
describe('the standard field list', () => {
  it('offers nothing a stranger must not be able to set', () => {
    const internal = [
      'statusId',
      'stageId',
      'pipelineId',
      'assignedUserId',
      'owner',
      'tags',
      'score',
      'lostReason',
      'priority',
      'leadSourceId',
    ];
    for (const field of FORM_STANDARD_FIELDS) {
      expect(internal).not.toContain(field.key);
      expect(internal).not.toContain(field.leadField ?? '');
    }
  });

  it('is a subset of what the product can actually capture', () => {
    // Every lead-targeting form field has to name a property the capture path knows. `fullName` and
    // `budget` are the two that are deliberately renamed for the person filling the form in.
    const importable = new Set(IMPORTABLE_LEAD_FIELDS.map((field) => field.field));
    for (const field of FORM_STANDARD_FIELDS) {
      if (field.target !== 'lead') continue;
      const known =
        importable.has(field.leadField ?? '') || ['valueMinor'].includes(field.leadField ?? '');
      expect(known, `${field.key} → ${field.leadField}`).toBe(true);
    }
  });

  it('declares where every answer goes, and nothing twice', () => {
    const keys = FORM_STANDARD_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const field of FORM_STANDARD_FIELDS) {
      if (field.target === 'lead') expect(field.leadField).toBeTruthy();
      if (field.target === 'consent') expect(field.consentKey).toBeTruthy();
    }
  });

  it('is looked up by key', () => {
    expect(formStandardField('phone')?.kind).toBe('phone');
    expect(formStandardField('statusId')).toBeUndefined();
  });
});

describe('the submitted field name', () => {
  it('keeps a custom field called city apart from the standard one', () => {
    const standard = formFieldName({ standardFieldKey: 'city', customFieldDefinitionId: null });
    const custom = formFieldName({ standardFieldKey: null, customFieldDefinitionId: 'abc' });
    expect(standard).toBe('standard:city');
    expect(custom).toBe('custom:abc');
    expect(standard).not.toBe(custom);
  });
});

describe('validateFormSubmission', () => {
  const field = (over: Partial<FormFieldView>): FormFieldView => ({
    id: 'f1',
    label: 'Phone number',
    kind: 'phone',
    name: 'standard:phone',
    required: true,
    stepIndex: 0,
    ...over,
  });

  it('accepts a complete submission', () => {
    expect(validateFormSubmission([field({})], { 'standard:phone': '98450 12345' })).toEqual([]);
  });

  it('asks for a required answer in a sentence a visitor can act on', () => {
    const [error] = validateFormSubmission([field({})], {});
    expect(error?.code).toBe('REQUIRED');
    expect(error?.message).toBe('Phone number is needed.');
  });

  it('ignores a blank optional answer', () => {
    expect(
      validateFormSubmission([field({ required: false })], { 'standard:phone': '  ' }),
    ).toEqual([]);
  });

  it('refuses something that is not an email, by name', () => {
    const fields = [field({ kind: 'email', label: 'Email address', name: 'standard:email' })];
    const [error] = validateFormSubmission(fields, { 'standard:email': 'nope' });
    expect(error?.code).toBe('NOT_AN_EMAIL');
    expect(error?.message).toContain('Email address');
  });

  it('refuses a number that is not one, and accepts one that is', () => {
    const fields = [field({ kind: 'number', label: 'Budget', name: 'standard:budget' })];
    expect(validateFormSubmission(fields, { 'standard:budget': '50000' })).toEqual([]);
    expect(validateFormSubmission(fields, { 'standard:budget': 'lots' })[0]?.code).toBe(
      'NOT_A_NUMBER',
    );
  });

  it('refuses an answer longer than the column', () => {
    const fields = [field({ maxLength: 5 })];
    expect(validateFormSubmission(fields, { 'standard:phone': '123456' })[0]?.code).toBe(
      'TOO_LONG',
    );
  });

  it('refuses a choice that was never offered', () => {
    const fields = [
      field({
        kind: 'select',
        label: 'Which service',
        name: 'custom:abc',
        options: [
          { value: 'a', label: 'Interiors' },
          { value: 'b', label: 'Construction' },
        ],
      }),
    ];
    expect(validateFormSubmission(fields, { 'custom:abc': 'a' })).toEqual([]);
    expect(validateFormSubmission(fields, { 'custom:abc': 'z' })[0]?.code).toBe('NOT_AN_OPTION');
  });

  it('treats a required consent box as a box that has to be ticked', () => {
    const fields = [
      field({ kind: 'checkbox', label: 'You may call me', name: 'standard:consentCalls' }),
    ];
    expect(validateFormSubmission(fields, { 'standard:consentCalls': 'on' })).toEqual([]);
    const [error] = validateFormSubmission(fields, {});
    expect(error?.code).toBe('CONSENT_REQUIRED');
    expect(error?.message).toBe('Please tick “You may call me”.');
  });

  it('leaves an optional consent box alone, whether ticked or not', () => {
    const fields = [
      field({
        kind: 'checkbox',
        required: false,
        name: 'standard:consentEmail',
        label: 'Email me',
      }),
    ];
    expect(validateFormSubmission(fields, {})).toEqual([]);
    expect(validateFormSubmission(fields, { 'standard:consentEmail': true })).toEqual([]);
  });

  it('reports every bad answer at once, not the first', () => {
    const fields = [
      field({ name: 'standard:phone' }),
      field({ kind: 'email', name: 'standard:email', label: 'Email address' }),
    ];
    expect(validateFormSubmission(fields, { 'standard:email': 'nope' })).toHaveLength(2);
  });
});

describe('the honeypot', () => {
  it('is tripped by anything in the hidden field', () => {
    expect(isHoneypotTripped({ [FORM_HONEYPOT_FIELD]: 'http://spam.example' })).toBe(true);
    expect(isHoneypotTripped({ [FORM_HONEYPOT_FIELD]: true })).toBe(true);
  });

  it('is not tripped by a person, who never sees the field', () => {
    expect(isHoneypotTripped({})).toBe(false);
    expect(isHoneypotTripped({ [FORM_HONEYPOT_FIELD]: '' })).toBe(false);
    expect(isHoneypotTripped({ [FORM_HONEYPOT_FIELD]: '   ' })).toBe(false);
  });
});

describe('normalizeUtm', () => {
  it('keeps the five keys and drops the rest', () => {
    expect(
      normalizeUtm({ utm_source: 'google', utm_medium: 'cpc', gclid: 'x', nonsense: 'y' }),
    ).toEqual({ utm_source: 'google', utm_medium: 'cpc' });
  });

  it('trims, caps the length, and drops what is empty', () => {
    const long = 'a'.repeat(400);
    const utm = normalizeUtm({ utm_campaign: `  ${long}  `, utm_term: '   ' });
    expect(utm['utm_campaign']).toHaveLength(200);
    expect(utm).not.toHaveProperty('utm_term');
  });

  it('answers an empty object for anything that is not an object', () => {
    expect(normalizeUtm(null)).toEqual({});
    expect(normalizeUtm('utm_source=google')).toEqual({});
    expect(normalizeUtm(undefined)).toEqual({});
  });
});
