import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIELD_SPECS,
  CUSTOM_FIELD_TYPES,
  RESERVED_FIELD_KEYS,
  customFieldSpec,
  isCustomFieldType,
  isValidCustomFieldKey,
} from './custom-fields.js';

describe('the custom-field registry', () => {
  it('describes every declared type — a type with no spec would be unimplementable', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(customFieldSpec(type), `${type} has no spec`).toBeDefined();
    }
    expect(Object.keys(CUSTOM_FIELD_SPECS).sort()).toEqual([...CUSTOM_FIELD_TYPES].sort());
  });

  it('gives every type at least one filter operator, or it could not be used in a view', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(customFieldSpec(type)!.operators.length, type).toBeGreaterThan(0);
    }
  });

  it('keeps multi-value types and array storage in step', () => {
    for (const spec of Object.values(CUSTOM_FIELD_SPECS)) {
      if (spec.multiValue) expect(spec.storage, spec.type).toBe('string[]');
      if (spec.storage === 'string[]') expect(spec.multiValue, spec.type).toBe(true);
    }
  });

  it('only marks a type searchable when its stored form is text', () => {
    for (const spec of Object.values(CUSTOM_FIELD_SPECS)) {
      if (spec.searchable) {
        expect(['string', 'string[]'], spec.type).toContain(spec.storage);
      }
    }
  });

  it('accepts a sensible key and refuses one that would break a JSON path or a filter', () => {
    expect(isValidCustomFieldKey('budget_max')).toBe(true);
    expect(isValidCustomFieldKey('b2')).toBe(true);
    // A dot reads as a JSON path; a quote ends up in generated SQL; uppercase makes two spellings of
    // one field; a leading digit is not an identifier.
    expect(isValidCustomFieldKey('budget.max')).toBe(false);
    expect(isValidCustomFieldKey("budget'max")).toBe(false);
    expect(isValidCustomFieldKey('BudgetMax')).toBe(false);
    expect(isValidCustomFieldKey('2beds')).toBe(false);
    expect(isValidCustomFieldKey('a')).toBe(false);
    expect(isValidCustomFieldKey('')).toBe(false);
  });

  it("refuses a key that collides with one of the lead's own columns", () => {
    // Otherwise a filter or an import header naming it would be ambiguous.
    for (const reserved of ['email', 'status', 'tags', 'score']) {
      expect(RESERVED_FIELD_KEYS.has(reserved)).toBe(true);
      expect(isValidCustomFieldKey(reserved), reserved).toBe(false);
    }
  });

  it('narrows a string to a type', () => {
    expect(isCustomFieldType('currency')).toBe(true);
    expect(isCustomFieldType('colour')).toBe(false);
  });
});
