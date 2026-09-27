import { describe, expect, it } from 'vitest';
import { AppError, type FieldError } from './errors.js';
import { CUSTOM_FIELD_TYPES, customFieldSpec } from './custom-fields.js';
import {
  searchTextFor,
  validateCustomValues,
  validateFieldDefinition,
  type CustomFieldDefinitionLike,
} from './custom-field-validation.js';

function field(
  overrides: Partial<CustomFieldDefinitionLike> & { type: string },
): CustomFieldDefinitionLike {
  return {
    key: 'f',
    label: 'Field',
    isRequired: false,
    isActive: true,
    validation: null,
    ...overrides,
  };
}

/** The values object for a single-field definition, or the thrown field errors. */
function run(
  definition: CustomFieldDefinitionLike,
  raw: unknown,
  options: Partial<Parameters<typeof validateCustomValues>[2]> = {},
): { ok: true; value: unknown } | { ok: false; errors: readonly FieldError[] } {
  try {
    const result = validateCustomValues(
      [definition],
      { [definition.key]: raw },
      {
        mode: 'create',
        ...options,
      },
    );
    return { ok: true, value: result.values[definition.key] };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, errors: error.details as FieldError[] };
    throw error;
  }
}

describe('unknown and absent keys', () => {
  it('rejects a key that is not a defined field', () => {
    const result = run(field({ type: 'text', key: 'budget' }), 'x');
    expect(result.ok).toBe(true);
    // …but a different key is refused, and the message names what is available.
    expect(() =>
      validateCustomValues(
        [field({ type: 'text', key: 'budget' })],
        { budgett: 'x' },
        { mode: 'create' },
      ),
    ).toThrow(AppError);
    try {
      validateCustomValues(
        [field({ type: 'text', key: 'budget' })],
        { budgett: 'x' },
        { mode: 'create' },
      );
    } catch (error) {
      const errors = (error as AppError).details as FieldError[];
      expect(errors[0]?.code).toBe('UNKNOWN_FIELD');
      expect(errors[0]?.message).toContain('budget');
    }
  });

  it('says so plainly when the organization has no custom fields at all', () => {
    try {
      validateCustomValues([], { anything: 1 }, { mode: 'create' });
      expect.unreachable();
    } catch (error) {
      expect(((error as AppError).details as FieldError[])[0]?.message).toContain(
        'no custom fields',
      );
    }
  });

  it('ignores an inactive definition entirely, rather than accepting values for it', () => {
    const result = run(field({ type: 'text', isActive: false }), 'x');
    expect(result.ok).toBe(false);
  });

  it('distinguishes absent from cleared', () => {
    const definition = field({ type: 'text', key: 'note' });
    // Absent: nothing said about it.
    const absent = validateCustomValues([definition], {}, { mode: 'patch' });
    expect(absent.values).toEqual({});
    expect(absent.cleared).toEqual([]);
    // Explicit null: clear it.
    const cleared = validateCustomValues([definition], { note: null }, { mode: 'patch' });
    expect(cleared.values).toEqual({});
    expect(cleared.cleared).toEqual(['note']);
  });

  it('enforces required fields on create but not on patch', () => {
    const definition = field({ type: 'text', key: 'source_note', isRequired: true });
    expect(() => validateCustomValues([definition], {}, { mode: 'create' })).toThrow(AppError);
    expect(validateCustomValues([definition], {}, { mode: 'patch' }).values).toEqual({});
  });

  it('refuses to clear a required field', () => {
    const definition = field({ type: 'text', key: 'source_note', isRequired: true });
    try {
      validateCustomValues([definition], { source_note: null }, { mode: 'patch' });
      expect.unreachable();
    } catch (error) {
      expect(((error as AppError).details as FieldError[])[0]?.code).toBe('REQUIRED');
    }
  });

  it('reports every bad field at once, not just the first', () => {
    const definitions = [
      field({ type: 'number', key: 'beds' }),
      field({ type: 'email', key: 'alt_email' }),
    ];
    try {
      validateCustomValues(definitions, { beds: 'many', alt_email: 'nope' }, { mode: 'create' });
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).details).toHaveLength(2);
    }
  });
});

describe('every supported type accepts and canonicalizes', () => {
  it('trims text and applies length and pattern rules', () => {
    expect(run(field({ type: 'text' }), '  hello  ')).toEqual({ ok: true, value: 'hello' });
    expect(run(field({ type: 'text', validation: { maxLength: 3 } }), 'hello').ok).toBe(false);
    expect(run(field({ type: 'text', validation: { minLength: 3 } }), 'hi').ok).toBe(false);
    expect(run(field({ type: 'text', validation: { regex: '^[A-Z]{2}$' } }), 'ab').ok).toBe(false);
    expect(run(field({ type: 'text', validation: { regex: '^[A-Z]{2}$' } }), 'AB')).toEqual({
      ok: true,
      value: 'AB',
    });
  });

  it('blames the definition, not the value, for a malformed pattern', () => {
    const result = run(field({ type: 'text', validation: { regex: '([' } }), 'anything');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('INVALID_DEFINITION');
  });

  it('lowercases an email and rejects a non-address', () => {
    expect(run(field({ type: 'email' }), ' Anita@Example.TEST ')).toEqual({
      ok: true,
      value: 'anita@example.test',
    });
    expect(run(field({ type: 'email' }), 'anita@example').ok).toBe(false);
    expect(run(field({ type: 'email' }), 'anita at example.test').ok).toBe(false);
  });

  it('accepts only http(s) URLs', () => {
    expect(run(field({ type: 'url' }), 'https://example.test/x')).toEqual({
      ok: true,
      value: 'https://example.test/x',
    });
    // A stored javascript: URL becomes an attack the moment a screen renders it as a link.
    expect(run(field({ type: 'url' }), 'javascript:alert(1)').ok).toBe(false);
    expect(run(field({ type: 'url' }), 'data:text/html,<script>').ok).toBe(false);
    expect(run(field({ type: 'url' }), 'not a url').ok).toBe(false);
  });

  it('normalizes a phone to E.164 using the organization default country', () => {
    expect(run(field({ type: 'phone' }), '98765 43210', { defaultPhoneCountry: 'IN' })).toEqual({
      ok: true,
      value: '+919876543210',
    });
    expect(
      run(field({ type: 'phone' }), '+44 20 7946 0958', { defaultPhoneCountry: 'IN' }),
    ).toEqual({
      ok: true,
      value: '+442079460958',
    });
    expect(run(field({ type: 'phone' }), 'call me').ok).toBe(false);
  });

  it('keeps numbers whole and decimals precise', () => {
    expect(run(field({ type: 'number' }), '42')).toEqual({ ok: true, value: 42 });
    expect(run(field({ type: 'number' }), 42.5).ok).toBe(false);
    expect(run(field({ type: 'decimal', validation: { precision: 2 } }), 1.23456)).toEqual({
      ok: true,
      value: 1.23,
    });
    expect(run(field({ type: 'number', validation: { min: 1, max: 5 } }), 9).ok).toBe(false);
    expect(run(field({ type: 'number' }), 'many').ok).toBe(false);
  });

  it('stores currency as integer minor units with a currency code', () => {
    expect(run(field({ type: 'currency' }), 4500.5, { defaultCurrency: 'INR' })).toEqual({
      ok: true,
      value: { amountMinor: 450050, currency: 'INR' },
    });
    expect(run(field({ type: 'currency' }), { amountMinor: 999, currency: 'gbp' })).toEqual({
      ok: true,
      value: { amountMinor: 999, currency: 'GBP' },
    });
    expect(run(field({ type: 'currency' }), { amountMinor: -1, currency: 'INR' }).ok).toBe(false);
    expect(run(field({ type: 'currency' }), { amountMinor: 1, currency: 'rupees' }).ok).toBe(false);
    // min/max are stated in major units, because that is how the field's author thinks about money.
    expect(run(field({ type: 'currency', validation: { min: 100 } }), 50).ok).toBe(false);
  });

  it('accepts the shapes a form and an import actually send for booleans', () => {
    for (const truthy of [true, 'true', 1, '1', 'yes']) {
      expect(run(field({ type: 'boolean' }), truthy)).toEqual({ ok: true, value: true });
    }
    for (const falsy of [false, 'false', 0, '0', 'no']) {
      expect(run(field({ type: 'boolean' }), falsy)).toEqual({ ok: true, value: false });
    }
    expect(run(field({ type: 'boolean' }), 'maybe').ok).toBe(false);
  });

  it('keeps a date timezone-free and refuses a date that does not exist', () => {
    expect(run(field({ type: 'date' }), '2026-01-05')).toEqual({ ok: true, value: '2026-01-05' });
    // A birthday is the same day everywhere, so a timestamp is refused rather than truncated in
    // whichever zone the server happens to run in.
    expect(run(field({ type: 'date' }), '2026-01-05T10:00:00Z').ok).toBe(false);
    expect(run(field({ type: 'date' }), '05/01/2026').ok).toBe(false);
    // Date would happily roll this into March.
    expect(run(field({ type: 'date' }), '2026-02-31').ok).toBe(false);
  });

  it('stores a datetime as a UTC instant', () => {
    expect(run(field({ type: 'datetime' }), '2026-01-05T10:30:00+05:30')).toEqual({
      ok: true,
      value: '2026-01-05T05:00:00.000Z',
    });
    expect(run(field({ type: 'datetime' }), 'sometime').ok).toBe(false);
  });

  it('applies date bounds', () => {
    expect(run(field({ type: 'date', validation: { min: '2026-01-01' } }), '2025-12-31').ok).toBe(
      false,
    );
    expect(run(field({ type: 'date', validation: { max: '2026-01-01' } }), '2026-06-01').ok).toBe(
      false,
    );
  });

  const choices = [
    { value: 'hot', isActive: true },
    { value: 'warm', isActive: true },
    { value: 'retired', isActive: false },
  ];

  it('accepts a defined choice and refuses an undefined one', () => {
    expect(run(field({ type: 'select', options: choices }), 'hot')).toEqual({
      ok: true,
      value: 'hot',
    });
    const bad = run(field({ type: 'select', options: choices }), 'lukewarm');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors[0]?.code).toBe('INVALID_CHOICE');
      // The message lists the live options only — offering a retired one would be misleading.
      expect(bad.errors[0]?.message).toContain('hot');
      expect(bad.errors[0]?.message).not.toContain('retired');
    }
  });

  it('refuses a deactivated option for a new value but distinguishes it from an unknown one', () => {
    const result = run(field({ type: 'select', options: choices }), 'retired');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('INACTIVE_CHOICE');
  });

  it('deduplicates a choice set and applies count rules', () => {
    expect(run(field({ type: 'multiselect', options: choices }), ['hot', 'hot', 'warm'])).toEqual({
      ok: true,
      value: ['hot', 'warm'],
    });
    // A single string is accepted, because that is what a form with one checkbox ticked sends.
    expect(run(field({ type: 'checkbox_group', options: choices }), 'hot')).toEqual({
      ok: true,
      value: ['hot'],
    });
    expect(
      run(field({ type: 'multiselect', options: choices, validation: { min: 2 } }), ['hot']).ok,
    ).toBe(false);
    expect(
      run(field({ type: 'multiselect', options: choices, validation: { max: 1 } }), ['hot', 'warm'])
        .ok,
    ).toBe(false);
  });

  it('bounds a rating by default even with no rules given', () => {
    expect(run(field({ type: 'rating' }), 3)).toEqual({ ok: true, value: 3 });
    expect(run(field({ type: 'rating' }), 0).ok).toBe(false);
    expect(run(field({ type: 'rating' }), 6).ok).toBe(false);
    // An explicit rule overrides the default, so a 10-point scale is possible.
    expect(run(field({ type: 'rating', validation: { max: 10 } }), 9)).toEqual({
      ok: true,
      value: 9,
    });
  });

  it('stores a file as a reference and applies type and size rules', () => {
    expect(
      run(field({ type: 'file' }), {
        documentId: 'd1',
        name: 'plan.pdf',
        size: 1024,
        mime: 'application/pdf',
      }),
    ).toEqual({
      ok: true,
      value: { documentId: 'd1', name: 'plan.pdf', size: 1024, mime: 'application/pdf' },
    });
    expect(run(field({ type: 'file' }), { name: 'plan.pdf' }).ok).toBe(false);
    expect(
      run(field({ type: 'file', validation: { fileTypes: ['application/pdf'] } }), {
        documentId: 'd1',
        name: 'x.png',
        mime: 'image/png',
        size: 10,
      }).ok,
    ).toBe(false);
    expect(
      run(field({ type: 'file', validation: { maxSizeKb: 1 } }), {
        documentId: 'd1',
        name: 'big.pdf',
        mime: 'application/pdf',
        size: 5000,
      }).ok,
    ).toBe(false);
  });

  it('covers every type in the registry — a new type cannot be added without a test here', () => {
    // The Phase 2 exit criterion is that a field of ANY supported type works immediately. That is
    // only true if nothing can be added to the registry without this file noticing.
    const tested = new Set([
      'text',
      'textarea',
      'number',
      'decimal',
      'currency',
      'boolean',
      'date',
      'datetime',
      'select',
      'multiselect',
      'radio',
      'checkbox_group',
      'email',
      'phone',
      'url',
      'rating',
      'file',
    ]);
    expect([...CUSTOM_FIELD_TYPES].filter((type) => !tested.has(type))).toEqual([]);
  });

  it('accepts a value for every registry type, so none is declared but unimplemented', () => {
    const sample: Record<string, unknown> = {
      text: 'x',
      textarea: 'x',
      number: 1,
      decimal: 1.5,
      currency: 10,
      boolean: true,
      date: '2026-01-05',
      datetime: '2026-01-05T00:00:00Z',
      select: 'hot',
      multiselect: ['hot'],
      radio: 'hot',
      checkbox_group: ['hot'],
      email: 'a@b.test',
      phone: '9876543210',
      url: 'https://example.test',
      rating: 3,
      file: { documentId: 'd', name: 'a.pdf', mime: 'application/pdf', size: 1 },
    };
    for (const type of CUSTOM_FIELD_TYPES) {
      const spec = customFieldSpec(type);
      const definition = field({
        type,
        ...(spec?.requiresOptions ? { options: choices } : {}),
      });
      const result = run(definition, sample[type], {
        defaultPhoneCountry: 'IN',
        defaultCurrency: 'INR',
      });
      expect(result.ok, `${type} rejected its own sample value`).toBe(true);
    }
  });
});

describe('searchTextFor', () => {
  it('includes only the types the registry marks searchable', () => {
    const definitions = [
      field({ type: 'text', key: 'note', label: 'Note' }),
      field({ type: 'number', key: 'beds', label: 'Beds' }),
      field({ type: 'multiselect', key: 'areas', label: 'Areas', options: [] }),
    ];
    const text = searchTextFor(definitions, {
      note: 'baner flat',
      beds: 3,
      areas: ['baner', 'aundh'],
    });
    expect(text).toContain('baner flat');
    expect(text).toContain('aundh');
    // A budget or a bedroom count has no business polluting a name search.
    expect(text).not.toContain('3');
  });

  it('is empty rather than undefined when nothing is searchable', () => {
    expect(searchTextFor([field({ type: 'number', key: 'beds' })], { beds: 3 })).toBe('');
  });
});

describe('validateFieldDefinition', () => {
  it('rejects an unknown type and lists the supported ones', () => {
    const errors = validateFieldDefinition({ type: 'colour_picker' });
    expect(errors[0]?.code).toBe('UNKNOWN_TYPE');
    expect(errors[0]?.message).toContain('select');
  });

  it('requires options for a choice type and forbids them otherwise', () => {
    expect(validateFieldDefinition({ type: 'select', optionCount: 0 })[0]?.code).toBe(
      'OPTIONS_REQUIRED',
    );
    expect(validateFieldDefinition({ type: 'select', optionCount: 2 })).toEqual([]);
    expect(validateFieldDefinition({ type: 'text', optionCount: 1 })[0]?.code).toBe(
      'OPTIONS_NOT_SUPPORTED',
    );
  });

  it('rejects a validation rule the type does not honour', () => {
    // A boolean with a regex is a definition that would quietly do nothing.
    const errors = validateFieldDefinition({ type: 'boolean', validation: { regex: '^x$' } });
    expect(errors[0]?.code).toBe('RULE_NOT_SUPPORTED');
  });

  it('rejects an invalid pattern and an inverted range at definition time', () => {
    expect(validateFieldDefinition({ type: 'text', validation: { regex: '([' } })[0]?.code).toBe(
      'INVALID_REGEX',
    );
    expect(
      validateFieldDefinition({ type: 'number', validation: { min: 10, max: 1 } })[0]?.code,
    ).toBe('RANGE_INVERTED');
  });

  it('accepts a sound definition for every type in the registry', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      const spec = customFieldSpec(type);
      const errors = validateFieldDefinition({
        type,
        optionCount: spec?.requiresOptions ? 2 : 0,
      });
      expect(errors, `${type} could not be defined`).toEqual([]);
    }
  });
});
